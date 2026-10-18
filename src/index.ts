import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MailboxInfo {
  id: string;
  address: string;
  ownership: "unclaimed" | "claimed";
  capabilities: Record<string, boolean>;
  limits: {
    messages: number;
    attachments: number;
    storage_bytes: number;
  } | null;
}
export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  received_at: string;
  attachment_count: number;
}
export interface Message extends MessageSummary {
  text: string;
  html: string | null;
  to: string[];
  cc: string[];
  reply_to: string | null;
  recipients_complete: boolean;
  attachments: Array<{
    id: string;
    filename: string;
    content_type: string;
    size: number;
    status: "pending" | "processing" | "ready" | "failed";
    download_path: string | null;
  }>;
}
export interface MessagePage {
  data: MessageSummary[];
  next_cursor: string | null;
}
export interface MailboxEvent {
  id: string;
  type: "message.received" | "message.attachments_settled";
  mailbox_id: string;
  message_id: string;
  created_at: string;
}
export type Webhook = {
  url: string;
  status: "active" | "paused";
  attempts: number;
} | null;
export interface EventPage {
  data: MailboxEvent[];
  next_cursor: string;
  has_more: boolean;
  poll_after_ms: number;
}
interface State {
  base_url: string;
  setup_token: string;
  access_token?: string;
  claim_secret?: string;
  claim_url?: string;
  event_cursor?: string;
  mailbox?: MailboxInfo;
}
export class MailboxError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly retryAfter?: number,
  ) {
    super(
      `Mailbox request failed: ${code}${status ? ` (HTTP ${status})` : ""}`,
    );
    this.name = "MailboxError";
  }
}
const isCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;
const credential = (value: unknown, prefix: string) =>
  typeof value === "string" &&
  new RegExp(`^ridian_${prefix}_[a-f0-9]{64}$`).test(value);

/** Node.js (Linux/macOS), one writer per private state file. No automatic retries. */
export class Mailbox {
  #baseUrl: string;
  #statePath: string;
  #timeout: number;
  #blockedUntil = 0;
  constructor({
    baseUrl = "https://services.getridian.com",
    state,
    timeout = 30_000,
  }: { baseUrl?: string; state?: string; timeout?: number } = {}) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new TypeError(
        "Use a fixed HTTPS origin without path or credentials.",
      );
    if (!Number.isInteger(timeout) || timeout <= 0)
      throw new TypeError("timeout must be positive");
    this.#baseUrl = url.origin;
    this.#statePath =
      state ??
      join(
        homedir(),
        ".config",
        "ridian",
        `mailbox-${url.hostname}${url.port ? "-" + url.port : ""}.json`,
      );
    this.#timeout = timeout;
  }
  async #state(create = false): Promise<State> {
    await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
    if (create) {
      let handle;
      try {
        handle = await open(
          this.#statePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
      } catch (error) {
        if (!isCode(error, "EEXIST"))
          throw new MailboxError("private_storage_unavailable");
      }
      if (handle) {
        const state = {
          base_url: this.#baseUrl,
          setup_token: "ridian_setup_" + randomBytes(32).toString("hex"),
        };
        try {
          await handle.writeFile(JSON.stringify(state));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return state;
      }
    }
    let handle;
    try {
      handle = await open(
        this.#statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      throw new MailboxError(
        isCode(error, "ENOENT")
          ? "setup_required"
          : "private_storage_unavailable",
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536)
        throw new MailboxError("state_must_be_private_file");
      const state: State = JSON.parse(await handle.readFile("utf8"));
      if (state.base_url !== this.#baseUrl)
        throw new MailboxError("state_origin_mismatch");
      if (!credential(state.setup_token, "setup"))
        throw new MailboxError("invalid_saved_credential");
      return state;
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError("invalid_saved_state");
    } finally {
      await handle.close();
    }
  }
  async #save(state: State) {
    const path =
      this.#statePath + "." + randomBytes(8).toString("hex") + ".tmp";
    const handle = await open(path, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(path, this.#statePath);
    } finally {
      await unlink(path).catch((error) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
    }
  }
  async #request<T>(
    path: string,
    {
      method = "GET",
      token,
      body,
      binary = false,
    }: {
      method?: string;
      token?: string;
      body?: unknown;
      binary?: boolean;
    } = {},
  ): Promise<T> {
    if (Date.now() < this.#blockedUntil)
      throw new MailboxError(
        "rate_limit",
        429,
        Math.max(1, Math.ceil((this.#blockedUntil - Date.now()) / 1000)),
      );
    token ??= (await this.#state()).access_token;
    if (!credential(token, "(?:setup|mailbox)"))
      throw new MailboxError("repeat_setup_with_saved_state");
    let response: Response;
    try {
      response = await fetch(this.#baseUrl + "/v1/mailboxes" + path, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      throw new MailboxError("transport_interrupted_reuse_state");
    }
    if (!response.ok) {
      let wait: number | undefined;
      if (response.status === 429) {
        const raw = response.headers.get("retry-after") ?? "60";
        const seconds = /^\d+$/.test(raw)
          ? Number(raw)
          : (Date.parse(raw) - Date.now()) / 1000;
        wait = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
        this.#blockedUntil = Date.now() + wait * 1000;
      }
      await response.body?.cancel();
      const codes: Record<number, string> = {
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        429: "rate_limit",
        503: "unavailable",
      };
      throw new MailboxError(
        response.status >= 300 && response.status < 400
          ? "redirect_refused"
          : (codes[response.status] ?? "http_error"),
        response.status,
        wait,
      );
    }
    try {
      return (
        response.status === 204
          ? undefined
          : binary
            ? new Uint8Array(await response.arrayBuffer())
            : await response.json()
      ) as T;
    } catch {
      throw new MailboxError("invalid_response");
    }
  }
  /** Recover the same mailbox and return public metadata. Credentials stay in the state file. */
  async setup(): Promise<MailboxInfo> {
    const state = await this.#state(true);
    const result = await this.#request<Partial<State>>("", {
      method: "POST",
      token: state.setup_token,
      body: {},
    });
    if (
      !result ||
      !result.mailbox ||
      typeof result.mailbox.address !== "string" ||
      !credential(result.access_token, "mailbox") ||
      typeof result.claim_secret !== "string" ||
      typeof result.claim_url !== "string"
    )
      throw new MailboxError("invalid_response_repeat_setup");
    await this.#save({
      ...state,
      mailbox: result.mailbox,
      access_token: result.access_token,
      claim_secret: result.claim_secret,
      claim_url: result.claim_url,
    });
    return result.mailbox;
  }
  status() {
    return this.#request<MailboxInfo>("/current");
  }
  #page(cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("limit must be between 1 and 50");
    return (
      "?" +
      new URLSearchParams({
        limit: String(limit),
        ...(cursor === undefined ? {} : { cursor }),
      })
    );
  }
  messages({ cursor, limit = 20 }: { cursor?: string; limit?: number } = {}) {
    return this.#request<MessagePage>(
      "/current/messages" + this.#page(cursor, limit),
    );
  }
  async *iterMessages({ limit = 20 } = {}) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.messages({ cursor, limit });
      if (
        !page ||
        !Array.isArray(page.data) ||
        (page.next_cursor !== null && typeof page.next_cursor !== "string")
      )
        throw new MailboxError("invalid_response");
      yield* page.data;
      cursor = page.next_cursor ?? undefined;
      if (cursor !== undefined) {
        if (!cursor || seen.has(cursor))
          throw new MailboxError("pagination_cursor_repeated");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  }
  message(id: string) {
    return this.#request<Message>(
      "/current/messages/" + encodeURIComponent(id),
    );
  }
  attachment(id: string) {
    return this.#request<Uint8Array>(
      "/current/attachments/" + encodeURIComponent(id),
      { binary: true },
    );
  }
  async events({
    cursor,
    limit = 20,
  }: { cursor?: string; limit?: number } = {}) {
    return this.#request<EventPage>(
      "/current/events" +
        this.#page(cursor ?? (await this.#state()).event_cursor, limit),
    );
  }
  async acknowledgeEvents(cursor: string) {
    if (typeof cursor !== "string" || !cursor || cursor.length > 4096)
      throw new TypeError("Use next_cursor from a fully processed page");
    const state = await this.#state();
    await this.#save({ ...state, event_cursor: cursor });
  }
  webhook() {
    return this.#request<Webhook>("/current/webhook");
  }
  setWebhook({ url, signingSecret }: { url: string; signingSecret: string }) {
    return this.#request<Webhook>("/current/webhook", {
      method: "POST",
      body: { url, signing_secret: signingSecret },
    });
  }
  resumeWebhook() {
    return this.#request<void>("/current/webhook/resume", { method: "POST" });
  }
  deleteWebhook() {
    return this.#request<void>("/current/webhook", { method: "DELETE" });
  }
  revoke() {
    return this.#request<void>("/current/access", { method: "DELETE" });
  }
}
