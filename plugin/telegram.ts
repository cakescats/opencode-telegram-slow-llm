import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const API = "https://api.telegram.org"
const LIMIT = 4096
const EDIT_MS = 3000
// The "thinking" message is edited this often while a task runs: elapsed time, the step,
// the latest reasoning. Telegram allows roughly one edit a second per chat.
const HEARTBEAT_MS = 3_000

type Piece = { message: string; kind: "text" | "reasoning"; text: string; pending?: boolean }
type Stream = {
  // every text and reasoning part of the run, in arrival order, with the assistant message it belongs to
  pieces: Map<string, Piece>
  // assistant messages of this run in order: the last one carries the final answer
  messages: string[]
  steps: string[]
  // what was decided on each permission request, kept in the thinking message as its history
  decisions: string[]
  error?: string
  sent: string
  // the send or edit of the thinking message on its way: the next tick skips instead of queueing
  // behind it, and finish() waits for it so a late edit cannot undo the final one
  inflight?: Promise<void>
  messageID?: number
  started: number
  waiting?: boolean
  waitingSince?: number
  done?: boolean
}

type Chat = {
  sessionID?: string
  stream?: Stream
  timer?: ReturnType<typeof setTimeout>
  busy: boolean
  touched: number
  queue: Promise<unknown>
  idle?: () => void
  queued: number
}

type Pending = {
  sessionID: string
  permissionID: string
  chatID: number
  timer: ReturnType<typeof setTimeout>
  at: number
  messageID: number
  text: string
  keyboard: unknown
  shown: string
  refreshed: number
  type: string
  ttl: number
  fallback: "reject" | "once"
  label: string
}

const HELP = [
  "opencode через Telegram.",
  "",
  "Просто пишите сообщения — они уйдут агенту.",
  "",
  "Команды:",
  "/new — начать новую сессию",
  "/stop — прервать текущий ответ",
  "/model — текущая модель",
  "/model <provider/model> — сменить модель",
  "/sessions — список сессий проекта",
  "/use <id> — подключиться к сессии",
  "/status — состояние сессии",
  "/settings — настройки: разрешения, ответ по умолчанию и его срок, быстрый режим",
  "/permissions — режим подтверждений",
  "/fast — быстрые ответы без размышлений (вкл/выкл)",
  "/password <новый> — сменить пароль доступа",
  "/who — кто авторизован",
  "/revoke — выйти из бота",
  "/menu — показать кнопки команд",
  "/help — эта справка",
].join("\n")

// The buttons under the input field. Each sends its label; handle() maps it to a command.
const BUTTONS: Record<string, string> = {
  "⏹ Стоп": "/stop",
  "🆕 Новая": "/new",
  "⚡ Быстро": "/fast",
  "📊 Статус": "/status",
  "📂 Сессии": "/sessions",
  "❓ Помощь": "/help",
  "⚙️ Настройки": "/settings",
}
const KEYBOARD = {
  keyboard: [
    [{ text: "⏹ Стоп" }, { text: "🆕 Новая" }, { text: "⚡ Быстро" }],
    [{ text: "📊 Статус" }, { text: "📂 Сессии" }, { text: "⚙️ Настройки" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Задача для агента…",
}
// The "Menu" list next to the input field (setMyCommands).
const MENU = [
  { command: "new", description: "Новая сессия" },
  { command: "stop", description: "Прервать текущий ответ" },
  { command: "fast", description: "Быстрые ответы без размышлений (вкл/выкл)" },
  { command: "status", description: "Состояние сессии" },
  { command: "sessions", description: "Сессии проекта" },
  { command: "use", description: "Подключиться к сессии: /use <id>" },
  { command: "model", description: "Модель: показать или сменить" },
  { command: "settings", description: "Настройки: разрешения, ответ по умолчанию, быстрый режим" },
  { command: "permissions", description: "Разрешения: ask | edits | allow | deny" },
  { command: "menu", description: "Показать кнопки команд" },
  { command: "help", description: "Справка" },
]

const envFile =
  process.env.TELEGRAM_ENV_FILE?.trim() || join(homedir(), ".config", "opencode", "telegram.env")

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)?\s*$/.exec(line)
    if (!match) continue
    const value = (match[2] || "").replace(/^["']|["']$/g, "").trim()
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

export default (async ({ client, directory, project, serverUrl }) => {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) return {}
  // Only the opencode-telegram service sets this. Without the check every opencode
  // process that loads plugins (the Desktop app too) started its own bridge, and two
  // pollers on one bot token fight over getUpdates (HTTP 409 Conflict).
  if (process.env.OPENCODE_TELEGRAM_BRIDGE !== "1") return {}

  const minutes = (name: string, fallback: number) => {
    const v = Number(process.env[name])
    return (Number.isFinite(v) && v > 0 ? v : fallback) * 60_000
  }
  // A local model is slow and a task can think for many minutes: abort only after this
  // much total silence, and never while the task waits for a confirmation button.
  const STUCK_MS = minutes("TELEGRAM_STUCK_MIN", 20)
  const PERMISSION_MS = minutes("TELEGRAM_PERMISSION_MIN", 10)

  const agent = process.env.TELEGRAM_AGENT?.trim() || "build"
  const debug = process.env.TELEGRAM_DEBUG === "1"
  const fallbackModel = process.env.TELEGRAM_MODEL?.trim()
  type Mode = "ask" | "edits" | "allow" | "deny"
  const MODES: Mode[] = ["ask", "edits", "allow", "deny"]
  const envMode = process.env.TELEGRAM_PERMISSIONS?.trim() as Mode
  const policy: Mode = MODES.includes(envMode) ? envMode : "ask"
  const allowed = new Set(
    (process.env.TELEGRAM_ALLOWED?.trim() || "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => !Number.isNaN(n)),
  )

  const lock = join(tmpdir(), `opencode-telegram-${token.slice(-8)}.lock`)
  const acquire = () => {
    if (existsSync(lock)) {
      const owner = Number(readFileSync(lock, "utf8").trim())
      if (owner && owner !== process.pid) {
        try {
          process.kill(owner, 0)
          return false
        } catch {}
      }
    }
    writeFileSync(lock, String(process.pid))
    return true
  }

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "telegram", level, message } }).catch(() => {})

  const chats = new Map<number, Chat>()
  // messages written by the user (their parts are echoed on the event stream too)
  const userMessages = new Set<string>()
  // parts that are neither text nor reasoning (tools, files, steps): their deltas are dropped
  const otherParts = new Set<string>()
  const sessions = new Map<string, number>()
  const models = new Map<number, string>()
  // Per-chat settings, kept in telegram-settings.json: permission mode, what happens to a
  // request nobody answers and after how long, the fast mode, the model.
  type Prefs = { mode?: Mode; onTimeout?: "reject" | "once"; timeoutSec?: number; fast?: boolean; model?: string }
  const settingsFile = join(homedir(), ".config", "opencode", "telegram-settings.json")
  const prefs = new Map<number, Prefs>()
  try {
    if (existsSync(settingsFile))
      for (const [id, p] of Object.entries(JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, Prefs>)) prefs.set(Number(id), p)
  } catch {}
  const savePrefs = () => {
    try {
      writeFileSync(settingsFile, JSON.stringify(Object.fromEntries(prefs)), { mode: 0o600 })
    } catch {}
  }
  const pref = (chatID: number) => prefs.get(chatID) ?? {}
  const setPref = (chatID: number, patch: Prefs) => {
    prefs.set(chatID, { ...pref(chatID), ...patch })
    savePrefs()
  }
  const modeOf = (chatID: number): Mode => pref(chatID).mode ?? policy
  const timeoutOf = (chatID: number) => (pref(chatID).timeoutSec ? pref(chatID).timeoutSec! * 1000 : PERMISSION_MS)
  const onTimeoutOf = (chatID: number) => pref(chatID).onTimeout ?? "reject"
  // file changes and reads; everything else (commands, web, subagents, other folders) is asked about in "edits"
  const EDIT_KINDS = new Set(["edit", "write", "patch", "multiedit", "read", "list", "glob", "grep", "todowrite", "todoread"])
  const decide = (chatID: number, type: string): "ask" | "allow" | "deny" => {
    const mode = modeOf(chatID)
    if (mode === "edits") return EDIT_KINDS.has(type) ? "allow" : "ask"
    return mode
  }
  const MODE_LABEL: Record<Mode, string> = {
    ask: "🔐 Спрашивать всё",
    edits: "✏️ Правки без вопросов, команды спрашивать",
    allow: "✅ Разрешено всё без запросов",
    deny: "👁 Только чтение (всё отклонять)",
  }
  const pending = new Map<string, Pending>()
  const attempts = new Map<number, { n: number; until: number }>()
  const usersFile = join(homedir(), ".config", "opencode", "telegram-users.json")
  // chat -> session, kept across restarts: without it a restart orphaned a running
  // session, and its permission requests had no chat to go to.
  const sessionsFile = join(homedir(), ".config", "opencode", "telegram-sessions.json")
  const asked = new Set<string>()
  let pass = process.env.TELEGRAM_PASSWORD?.trim() || ""
  let offset = 0
  let running = true
  let polling = false

  const chat = (chatID: number) => {
    const found = chats.get(chatID)
    if (found) return found
    const created: Chat = { busy: false, touched: Date.now(), queue: Promise.resolve(), queued: 0 }
    chats.set(chatID, created)
    return created
  }
  const touch = (chatID: number) => {
    const found = chats.get(chatID)
    if (found) found.touched = Date.now()
  }

  const users = new Set<number>(allowed)
  if (existsSync(usersFile)) {
    try {
      for (const id of JSON.parse(readFileSync(usersFile, "utf8")) as number[]) users.add(Number(id))
    } catch (err) {
      log("warn", `users file unreadable: ${String(err)}`)
    }
  }
  const saveUsers = () => {
    try {
      writeFileSync(usersFile, JSON.stringify([...users]), { mode: 0o600 })
    } catch (err) {
      // access is granted for this run either way; say so in the log rather than drop the reply
      log("error", `users file not saved: ${String(err)}`)
    }
  }
  const saveSessions = () => {
    const out: Record<string, string> = {}
    for (const [chatID, state] of chats) if (state.sessionID) out[String(chatID)] = state.sessionID
    try {
      writeFileSync(sessionsFile, JSON.stringify(out), { mode: 0o600 })
    } catch (err) {
      log("warn", `sessions file: ${String(err)}`)
    }
  }
  if (existsSync(sessionsFile)) {
    try {
      for (const [id, sessionID] of Object.entries(JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, string>)) {
        const chatID = Number(id)
        if (!sessionID || Number.isNaN(chatID)) continue
        chat(chatID).sessionID = sessionID
        sessions.set(sessionID, chatID)
      }
    } catch (err) {
      log("warn", `sessions file unreadable: ${String(err)}`)
    }
  }

  const same = (a: string, b: string) => {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
  }

  const call = async <T>(method: string, body: Record<string, unknown>, attempt = 0): Promise<T | undefined> => {
    // A fresh connection per call and a deadline: reusing a pooled keep-alive socket that
    // Telegram (or a NAT on the way) has already closed failed with "The socket connection
    // was closed unexpectedly", most often on the 30 s long poll.
    // Bun's fetch here now and then hangs ~20 s on a connection and then fails ("socket
    // connection was closed unexpectedly"), about one call in seven, while curl on the same
    // host never does. A short deadline and a quick retry turn that into a second's delay.
    const wait = method === "getUpdates" ? ((body.timeout as number) || 0) * 1000 + 15_000 : method === "editMessageText" ? 4_000 : 6_000
    let res: Response
    try {
      res = await fetch(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify(body),
        keepalive: false,
        signal: AbortSignal.timeout(wait),
      })
    } catch (err) {
      // a dropped or timed-out connection: retry, so a reply or a button is not lost to it
      // an edit is not retried: the next tick sends fresher text anyway
      if (attempt < 3 && method !== "getUpdates" && method !== "editMessageText") {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        return call<T>(method, body, attempt + 1)
      }
      throw err
    }
    const data = (await res.json()) as { ok: boolean; result: T; description?: string }
    if (data.ok) return data.result
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
      return call<T>(method, body, attempt + 1)
    }
    throw new Error(data.description || `telegram ${method} failed (${res.status})`)
  }

  const chunks = (text: string) => {
    if (text.length <= LIMIT) return [text]
    const out: string[] = []
    let rest = text
    while (rest.length > LIMIT) {
      let cut = rest.lastIndexOf("\n\n", LIMIT)
      if (cut < LIMIT * 0.5) cut = rest.lastIndexOf("\n", LIMIT)
      if (cut < LIMIT * 0.5) cut = rest.lastIndexOf(" ", LIMIT)
      if (cut < LIMIT * 0.5) cut = LIMIT
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\n+/, "")
    }
    if (rest.trim()) out.push(rest)
    return out
  }

  const send = async (chatID: number, text: string, keyboard?: unknown) => {
    const parts = chunks(text)
    let messageID: number | undefined
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      const result = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatID,
        text: parts[i],
        disable_web_page_preview: true,
        ...(last && keyboard ? { reply_markup: keyboard } : {}),
      })
      messageID = result?.message_id ?? messageID
    }
    return messageID
  }

  const edit = async (chatID: number, messageID: number, text: string, keyboard?: unknown) => {
    try {
      await call("editMessageText", {
        chat_id: chatID,
        message_id: messageID,
        text,
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      return true
    } catch (err) {
      // "message is not modified" is not a failure: the text is already what we want
      if (/not modified/i.test(String(err))) return true
      log("warn", `edit failed: ${String(err)}`)
      return false
    }
  }
  const hhmm = () => new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const sendHtml = async (chatID: number, html: string) =>
    (await call<{ message_id: number }>("sendMessage", { chat_id: chatID, text: html, parse_mode: "HTML", disable_web_page_preview: true }))?.message_id
  const editHtml = async (chatID: number, messageID: number, html: string) => {
    try {
      await call("editMessageText", { chat_id: chatID, message_id: messageID, text: html, parse_mode: "HTML", disable_web_page_preview: true })
      return true
    } catch (err) {
      if (/not modified/i.test(String(err))) return true
      log("warn", `edit failed: ${String(err)}`)
      return false
    }
  }

  const clock = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000))
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} с`
  }
  // The final answer is the text of the run's last assistant message; texts of earlier
  // messages (between tool steps) are interim notes and stay in the thinking message.
  const pieces = (stream: Stream, kind: Piece["kind"]) => [...stream.pieces.values()].filter((p) => !p.pending && p.kind === kind && p.text.trim())
  const answerOf = (stream: Stream) => {
    const last = stream.messages.at(-1)
    return pieces(stream, "text").filter((p) => p.message === last).map((p) => p.text.trim()).join("\n\n")
  }
  const notesOf = (stream: Stream) => {
    const last = stream.messages.at(-1)
    return pieces(stream, "text").filter((p) => p.message !== last).map((p) => p.text.trim())
  }
  // The last paragraph of a text (after the last blank line); a paragraph with no blank lines
  // in it falls back to its last lines, and anything over 600 characters keeps its tail.
  const lastParagraph = (text: string) => {
    const paras = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    let para = paras.at(-1) ?? ""
    if (para.length > 600) {
      const lines = para.split("\n").filter((l) => l.trim())
      let tail = ""
      for (let i = lines.length - 1; i >= 0 && tail.length < 300; i--) tail = tail ? `${lines[i]}\n${tail}` : lines[i]
      para = tail.length > 600 ? `…${tail.slice(-600)}` : `…${tail}`
    }
    return para
  }
  const errorLine = (stream: Stream) =>
    stream.error ? `${/^\p{Extended_Pictographic}/u.test(stream.error) ? "" : "❌ "}${stream.error}` : ""

  // The thinking message: status, steps, the latest interim note and the reasoning (in a
  // collapsible quote). The answer is never in it: it goes out as its own message at the end.
  const renderThinking = (stream: Stream) => {
    const took = clock(Date.now() - stream.started)
    const writing = !stream.done && answerOf(stream) !== ""
    const doing = stream.waiting
      ? `🔐 ждёт вашего решения ${clock(Date.now() - (stream.waitingSince ?? Date.now()))}`
      : writing
        ? "✍️ пишет ответ"
        : stream.steps.length
          ? `шаг ${stream.steps.length}`
          : "думает"
    const head = stream.done ? `💭 <b>Размышления</b> · ${took}` : `💭 <b>Думаю</b> · ${took} · ${doing}`
    const steps = stream.steps.length ? `\n⚙ ${esc(stream.steps.join(" → "))}` : ""
    const decided = stream.decisions.length
      ? `\n${stream.decisions.length > 6 ? `… ещё ${stream.decisions.length - 6}\n` : ""}${esc(stream.decisions.slice(-6).join("\n"))}`
      : ""
    const note = notesOf(stream).at(-1)
    const interim = note ? `\n📝 ${esc(note.length > 400 ? `…${note.slice(-400)}` : note)}` : ""
    // Only the paragraph being thought right now, not the whole reasoning growing downwards.
    const para = lastParagraph(pieces(stream, "reasoning").at(-1)?.text ?? "")
    const quote = para ? `\n<blockquote>${esc(para)}</blockquote>` : ""
    const tail = stream.error ? `\n\n${esc(errorLine(stream))}` : ""
    return `${head}${steps}${decided}${interim}${quote}${tail}`
  }

  // Only ever edits the thinking message; a new one is sent only if there is none yet.
  const flush = async (chatID: number) => {
    const chat = chats.get(chatID)
    if (!chat?.stream) return
    const html = renderThinking(chat.stream)
    const stream = chat.stream
    if (html === stream.sent || stream.inflight) return
    stream.inflight = (async () => {
      if (stream.messageID) {
        if (await editHtml(chatID, stream.messageID, html)) stream.sent = html
      } else {
        // the first send goes through here too, so a slow one is never sent a second time
        stream.messageID = await sendHtml(chatID, html)
        stream.sent = html
      }
    })().finally(() => {
      stream.inflight = undefined
    })
    await stream.inflight
  }

  // Throttle, not debounce: while tokens stream without a pause a debounce kept postponing
  // the edit, and the message sat still until the model stopped.
  const schedule = (chatID: number) => {
    const chat = chats.get(chatID)
    if (!chat || chat.timer) return
    chat.timer = setTimeout(() => {
      chat.timer = undefined
      void flush(chatID)
    }, EDIT_MS)
  }

  const finish = async (chatID: number) => {
    const chat = chats.get(chatID)
    if (!chat) return
    if (chat.timer) clearTimeout(chat.timer)
    chat.timer = undefined
    chat.busy = false
    const release = chat.idle
    chat.idle = undefined
    if (!chat.stream) return release?.()
    const stream = chat.stream
    stream.done = true
    stream.waiting = false
    chat.stream = undefined
    // let a send or edit already on its way land first: the final form must be the last edit
    await stream.inflight?.catch(() => {})
    const answer = answerOf(stream)
    const thought = pieces(stream, "reasoning").length > 0 || stream.steps.length > 0 || stream.decisions.length > 0 || notesOf(stream).length > 0
    // 1. the thinking message gets its final form, or goes away if there was nothing to show
    if (stream.messageID) {
      if (thought || (!answer && stream.error)) await editHtml(chatID, stream.messageID, renderThinking(stream))
      else await call("deleteMessage", { chat_id: chatID, message_id: stream.messageID }).catch(() => {})
    } else if (thought) {
      await sendHtml(chatID, renderThinking(stream)).catch(() => {})
    }
    // 2. the answer, as its own message after the thinking
    if (answer) {
      const tail = stream.error ? `\n\n${errorLine(stream)}` : ""
      for (const part of chunks(answer + tail)) await send(chatID, part)
    } else if (!stream.error) {
      await send(chatID, "🤷 Агент закончил без текстового ответа.")
    }
    release?.()
  }

  const prompt = async (chatID: number, text: string) => {
    const state = chat(chatID)
    if (state.busy || state.queued > 0) {
      await send(chatID, `📥 В очереди (${state.queued + 1}): начну, когда закончу текущую задачу. /stop — прервать её.`).catch(() => {})
    }
    state.queued++
    state.queue = state.queue.then(async () => {
      state.queued--
      touch(chatID)
      if (!state.sessionID) {
        const created = await client.session.create({ query: { directory }, body: { title: "telegram" } })
        if (created.error || !created.data) throw new Error(`cannot create session`)
        state.sessionID = created.data.id
        sessions.set(created.data.id, chatID)
        saveSessions()
        log("info", `chat ${chatID} -> session ${state.sessionID}`)
      }
      state.busy = true
      state.touched = Date.now()
      state.stream = { pieces: new Map(), messages: [], steps: [], decisions: [], sent: "", started: Date.now() }
      void flush(chatID).catch((err) => log("warn", `thinking message: ${String(err)}`))
      const idle = new Promise<void>((resolve) => (state.idle = resolve))
      const model = pref(chatID).model || fallbackModel
      const split = model?.includes("/") ? model.split("/") : undefined
      // "/no_think" at the end of a message is the model server's switch for a direct answer.
      const body = {
        agent,
        ...(split ? { model: { providerID: split[0], modelID: split.slice(1).join("/") } } : {}),
        parts: [{ type: "text" as const, text: pref(chatID).fast ? `${text} /no_think` : text }],
      }
      // prompt_async returns at once; the run ends with session.idle -> finish(). The
      // blocking prompt() kept this handler (and with it the Telegram poll loop) waiting
      // for the whole answer, so buttons, /stop and other chats went unanswered meanwhile.
      const start = (client.session as any).promptAsync ?? client.session.prompt
      const result = await start.call(client.session, { query: { directory }, path: { id: state.sessionID }, body })
      if (result?.error) {
        if (state.stream) state.stream.error = result.error.data?.message || JSON.stringify(result.error)
        await finish(chatID)
        return
      }
      await idle
    }).catch(async (err) => {
      // caught here, on the chain itself, so one failed task does not reject every later one
      log("error", `chat ${chatID}: ${String(err)}`)
      state.busy = false
      state.idle = undefined
      await send(chatID, `❌ ${String(err)}`).catch(() => {})
    })
    return state.queue
  }

  const commands: Record<string, (chatID: number, arg: string) => Promise<void>> = {
    "/start": async (chatID) => send(chatID, `${HELP}\n\nПроект: ${project.worktree || directory}`, KEYBOARD).then(() => {}),
    "/help": async (chatID) => send(chatID, HELP, KEYBOARD).then(() => {}),
    "/menu": async (chatID) => send(chatID, "Кнопки команд — под полем ввода.", KEYBOARD).then(() => {}),
    "/new": async (chatID) => {
      const state = chats.get(chatID)
      if (state?.sessionID) {
        sessions.delete(state.sessionID)
        await client.session.delete({ query: { directory }, path: { id: state.sessionID } }).catch(() => {})
      }
      state?.idle?.()
      chats.delete(chatID)
      saveSessions()
      await send(chatID, "🆕 Новая сессия. Настройки чата сохранены (⚙️ Настройки).")
    },
    "/stop": async (chatID) => {
      const state = chats.get(chatID)
      if (!state?.sessionID || !state.busy) return send(chatID, "Нечего прерывать.").then(() => {})
      await client.session.abort({ query: { directory }, path: { id: state.sessionID } })
      if (state.stream) state.stream.error = "🛑 Остановлено по вашей команде."
      await finish(chatID)
    },
    "/fast": async (chatID) => {
      setPref(chatID, { fast: !pref(chatID).fast })
      await send(
        chatID,
        pref(chatID).fast
          ? "⚡ Быстрый режим: отвечаю без размышлений. Для сложных задач выключите: /fast"
          : "🧠 Обычный режим: с размышлениями (медленнее, но умнее).",
      )
    },
    "/model": async (chatID, arg) => {
      if (!arg) return send(chatID, `Модель: ${pref(chatID).model || fallbackModel || "из конфига"}`).then(() => {})
      setPref(chatID, { model: arg })
      await send(chatID, `Модель: ${arg}\nПрименится со следующего сообщения.`)
    },
    "/status": async (chatID) => {
      const chat = chats.get(chatID)
      if (!chat?.sessionID) return send(chatID, "Сессии нет.").then(() => {})
      await send(
        chatID,
        [
          `Сессия: ${chat.sessionID}`,
          `Агент: ${agent}`,
          `Модель: ${pref(chatID).model || fallbackModel || "default"}`,
          `Режим: ${pref(chatID).fast ? "быстрый (без размышлений)" : "с размышлениями"}`,
          `Разрешения: ${MODE_LABEL[modeOf(chatID)]}`,
          `Состояние: ${chat.busy ? "занята" : "свободна"}`,
          `Проект: ${project.worktree || directory}`,
        ].join("\n"),
      )
    },
    "/sessions": async (chatID) => {
      const res = await client.session.list({ query: { directory } })
      const all = (res.data || []).filter((s) => !s.parentID).slice(0, 20)
      if (!all.length) return send(chatID, "Сессий нет.").then(() => {})
      const current = chats.get(chatID)?.sessionID
      const when = (ms: number) => {
        const diff = Date.now() - ms
        if (diff < 60_000) return "только что"
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`
        return `${Math.floor(diff / 86_400_000)} дн назад`
      }
      const lines = all.map(
        (s) =>
          `${s.id === current ? "▶️" : "▫️"} ${s.id.slice(0, 8)} · ${when(s.time.updated || s.time.created)}\n   ${(s.title || "без названия").slice(0, 60)}`,
      )
      await send(chatID, [`Сессии (${all.length}):`, ...lines, "", "Подключиться: /use <id>"].join("\n"))
    },
    "/use": async (chatID, arg) => {
      const id = arg.trim()
      if (!id) return send(chatID, "Укажите id: /use ses_abc123").then(() => {})
      const res = await client.session.list({ query: { directory } })
      const found = (res.data || []).find((s) => s.id === id || s.id.startsWith(id))
      if (!found) return send(chatID, `Сессия ${id} не найдена.`).then(() => {})
      const state = chat(chatID)
      if (state.sessionID && state.sessionID !== found.id) sessions.delete(state.sessionID)
      state.sessionID = found.id
      state.busy = false
      state.stream = undefined
      sessions.set(found.id, chatID)
      saveSessions()
      await send(chatID, `✅ Подключено: ${found.title || found.id}\n${found.id}`)
    },
    "/permissions": async (chatID, arg) => {
      const next = arg.trim().toLowerCase() as Mode
      if (!next) return send(chatID, `Разрешения: ${MODE_LABEL[modeOf(chatID)]}\nВарианты: /permissions ask | edits | allow | deny, или ⚙️ Настройки`).then(() => {})
      if (!MODES.includes(next)) return send(chatID, "Допустимо: ask, edits, allow, deny").then(() => {})
      setPref(chatID, { mode: next })
      await send(chatID, `Разрешения: ${MODE_LABEL[next]}`)
    },
    "/settings": async (chatID) => {
      await send(chatID, settingsText(chatID), settingsKeyboard(chatID))
    },
    "/password": async (chatID, arg) => {
      const next = arg.trim()
      if (!next) return send(chatID, `Пароль: ${pass ? "задан" : "не задан"}\nСмена: /password <новый>`).then(() => {})
      if (next.length < 6) return send(chatID, "Минимум 6 символов.").then(() => {})
      const raw = existsSync(envFile) ? readFileSync(envFile, "utf8") : ""
      const lines = raw.split("\n")
      const at = lines.findIndex((l) => /^\s*(?:export\s+)?TELEGRAM_PASSWORD\s*=/.test(l))
      const entry = `TELEGRAM_PASSWORD=${next}`
      if (at >= 0) lines[at] = entry
      else lines.push(entry)
      writeFileSync(envFile, lines.join("\n"), { mode: 0o600 })
      pass = next
      process.env.TELEGRAM_PASSWORD = next
      await send(chatID, "🔑 Пароль обновлён. Старый больше не работает.")
    },
    "/who": async (chatID) => {
      const list = [...users].map((id) => (id === chatID ? `${id} (этот чат)` : String(id)))
      await send(chatID, `Авторизовано чатов: ${users.size}\n${list.join("\n") || "—"}\n\nВыйти: /revoke`)
    },
    "/revoke": async (chatID) => {
      users.delete(chatID)
      saveUsers()
      const state = chats.get(chatID)
      if (state?.sessionID) sessions.delete(state.sessionID)
      chats.delete(chatID)
      saveSessions()
      await send(chatID, "🔒 Доступ закрыт.")
    },
  }

  const TIMEOUTS = [30, 60, 120, 300, 600]
  const settingsText = (chatID: number) => {
    const p = pref(chatID)
    return [
      "⚙️ Настройки этого чата",
      "",
      `Разрешения: ${MODE_LABEL[modeOf(chatID)]}`,
      `Если не ответить на запрос: ${onTimeoutOf(chatID) === "once" ? "✅ разрешить" : "⛔ отклонить"} через ${clock(timeoutOf(chatID))}`,
      `Быстрый режим (без размышлений): ${p.fast ? "вкл" : "выкл"}`,
      modeOf(chatID) === "allow" ? "\n⚠️ Агент выполняет любые команды без вопросов — давайте пароль только тем, кому доверяете." : "",
    ].join("\n").trim()
  }
  const settingsKeyboard = (chatID: number) => {
    const mark = (on: boolean, t: string) => (on ? `● ${t}` : t)
    const mode = modeOf(chatID)
    const tsec = Math.round(timeoutOf(chatID) / 1000)
    return {
      inline_keyboard: [
        [{ text: mark(mode === "ask", "🔐 Спрашивать"), callback_data: "s:mode:ask" }, { text: mark(mode === "edits", "✏️ Правки сами"), callback_data: "s:mode:edits" }],
        [{ text: mark(mode === "allow", "✅ Всё без запросов"), callback_data: "s:mode:allow" }, { text: mark(mode === "deny", "👁 Только чтение"), callback_data: "s:mode:deny" }],
        [
          { text: mark(onTimeoutOf(chatID) === "reject", "По умолч.: ⛔ отклонить"), callback_data: "s:def:reject" },
          { text: mark(onTimeoutOf(chatID) === "once", "✅ разрешить"), callback_data: "s:def:once" },
        ],
        TIMEOUTS.map((t) => ({ text: mark(tsec === t, t < 60 ? `${t} с` : `${t / 60} мин`), callback_data: `s:ttl:${t}` })),
        [{ text: pref(chatID).fast ? "⚡ Быстрый режим: вкл" : "🧠 Быстрый режим: выкл", callback_data: "s:fast:toggle" }, { text: "✖ Закрыть", callback_data: "s:close:1" }],
      ],
    }
  }
  const onSettings = async (cb: any, key: string, value: string) => {
    const chatID = cb.message?.chat?.id as number | undefined
    const messageID = cb.message?.message_id as number | undefined
    if (chatID === undefined || messageID === undefined) return
    if (!users.has(chatID) && !(cb.from?.id && users.has(cb.from.id))) {
      await call("answerCallbackQuery", { callback_query_id: cb.id, text: "Сначала войдите по паролю" }).catch(() => {})
      return
    }
    let toast = "Сохранено"
    if (key === "mode" && MODES.includes(value as Mode)) setPref(chatID, { mode: value as Mode }), (toast = MODE_LABEL[value as Mode])
    else if (key === "def" && (value === "reject" || value === "once")) setPref(chatID, { onTimeout: value }), (toast = value === "once" ? "По умолчанию: разрешить" : "По умолчанию: отклонить")
    else if (key === "ttl" && TIMEOUTS.includes(Number(value))) setPref(chatID, { timeoutSec: Number(value) }), (toast = `Срок ответа: ${clock(Number(value) * 1000)}`)
    else if (key === "fast") setPref(chatID, { fast: !pref(chatID).fast }), (toast = pref(chatID).fast ? "Быстрый режим включён" : "Быстрый режим выключен")
    else if (key === "close") {
      await call("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {})
      await edit(chatID, messageID, `${settingsText(chatID)}\n\nИзменить: ⚙️ Настройки`).catch(() => {})
      return
    }
    await call("answerCallbackQuery", { callback_query_id: cb.id, text: toast }).catch(() => {})
    await edit(chatID, messageID, settingsText(chatID), settingsKeyboard(chatID)).catch(() => {})
    // requests already waiting follow the new mode at once
    if (key === "mode") {
      for (const [token, entry] of pending) {
        if (entry.chatID !== chatID) continue
        const verdict = decide(chatID, entry.type)
        if (verdict === "allow") await settle(token, "once")
        else if (verdict === "deny") await settle(token, "reject")
      }
    }
  }

  const handle = async (chatID: number, text: string) => {
    touch(chatID)
    text = BUTTONS[text.trim()] ?? text
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(/\s+/)
      const handler = commands[cmd.toLowerCase()]
      if (handler) return handler(chatID, rest.join(" "))
      const state = chats.get(chatID)
      if (state?.sessionID && state.busy) await client.session.abort({ query: { directory }, path: { id: state.sessionID } })
      return send(chatID, `Неизвестная команда: ${cmd}\n${HELP}`).then(() => {})
    }
    return prompt(chatID, text)
  }

  const reply = async (sessionID: string, permissionID: string, response: "once" | "always" | "reject") => {
    const res = await client.postSessionIdPermissionsPermissionId({
      query: { directory },
      path: { id: sessionID, permissionID },
      body: { response },
    })
    if (res.error) log("error", `permission reply failed ${permissionID}: ${JSON.stringify(res.error)}`)
    return !res.error
  }

  const permLabel = (perm: { type: string; pattern?: string | string[] }) => {
    const what = [perm.pattern].flat().filter(Boolean).join(", ").replace(/\s+/g, " ").trim()
    return what ? `${perm.type}: ${what.length > 60 ? `${what.slice(0, 60)}…` : what}` : perm.type
  }
  const askPermission = async (perm: { id: string; sessionID: string; type: string; title: string; pattern?: string | string[] }) => {
    const chatID = sessions.get(perm.sessionID)
    if (chatID === undefined) return
    if (asked.has(perm.id)) return
    asked.add(perm.id)
    const verdict = decide(chatID, perm.type)
    if (verdict !== "ask") {
      log("info", `auto-${verdict} permission ${perm.type} in chat ${chatID}`)
      await reply(perm.sessionID, perm.id, verdict === "allow" ? "once" : "reject")
      // a line in the thinking message instead of a button: what was done on its own
      const stream = chats.get(chatID)?.stream
      if (stream) {
        stream.decisions.push(`${verdict === "allow" ? "✅" : "⛔"} ${permLabel(perm)} · ${verdict === "allow" ? "разрешено" : "отклонено"} автоматически`)
        schedule(chatID)
      }
      return
    }
    const token = Math.random().toString(36).slice(2, 10)
    const detail = perm.pattern ? `\n${[perm.pattern].flat().join(", ").slice(0, 600)}` : ""
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Разрешить", callback_data: `p:${token}:once` },
          { text: "♾️ Всегда", callback_data: `p:${token}:always` },
          { text: "⛔ Отклонить", callback_data: `p:${token}:reject` },
        ],
      ],
    }
    log("info", `permission ${perm.id} (${perm.type}) chat ${chatID}`)
    const text = `🔐 ${perm.title}\n${perm.type}${detail}`
    const label = permLabel(perm)
    const shown = countdown(text, 0, timeoutOf(chatID), onTimeoutOf(chatID))
    const sent = await send(chatID, shown, keyboard).catch(() => undefined)
    if (sent === undefined) {
      await reply(perm.sessionID, perm.id, "reject")
      return
    }
    pending.set(token, {
      sessionID: perm.sessionID,
      permissionID: perm.id,
      chatID,
      timer: setTimeout(() => {}, timeoutOf(chatID)),
      at: Date.now(),
      type: perm.type,
      ttl: timeoutOf(chatID),
      fallback: onTimeoutOf(chatID),
      label,
      messageID: sent,
      text,
      keyboard,
      shown,
      refreshed: Date.now(),
    })
    const stream = chats.get(chatID)?.stream
    if (stream) {
      if (!stream.waiting) stream.waitingSince = Date.now()
      stream.waiting = true
      schedule(chatID)
    }
  }

  const VERDICT = { once: "✅ Разрешено один раз", always: "♾️ Разрешено всегда", reject: "⛔ Отклонено" } as const
  const countdown = (text: string, waited: number, ttl: number, fallback: "reject" | "once") =>
    `${text}\n\n⏳ ждёт ${clock(waited)} · через ${clock(Math.max(0, ttl - waited))} само: ${fallback === "once" ? "✅ разрешить" : "⛔ отклонить"}`
  // Take a request off the list and rewrite its message with the outcome (no new message).
  const close = async (token: string, outcome: string) => {
    const entry = pending.get(token)
    if (!entry) return undefined
    pending.delete(token)
    clearTimeout(entry.timer)
    const stream = chats.get(entry.chatID)?.stream
    if (stream) {
      stream.waiting = [...pending.values()].some((p) => p.chatID === entry.chatID)
      if (!stream.waiting) stream.waitingSince = undefined
      schedule(entry.chatID)
    }
    touch(entry.chatID)
    const line = `${outcome.split(" ")[0]} ${entry.label} · ${outcome.split(" ").slice(1).join(" ").toLowerCase()} · ждал ${clock(Date.now() - entry.at)}`
    if (stream) {
      // the decision joins the thinking message; the button message goes, so the thinking stays the last one
      stream.decisions.push(line)
      schedule(entry.chatID)
      await call("deleteMessage", { chat_id: entry.chatID, message_id: entry.messageID }).catch(async () => {
        await edit(entry.chatID, entry.messageID, `${entry.text}\n\n${outcome} · ${hhmm()}`).catch(() => {})
      })
    } else {
      // no live task to attach it to (it finished, or the bridge restarted): mark the request itself
      await edit(entry.chatID, entry.messageID, `${entry.text}\n\n${outcome} · ${hhmm()} (ждал ${clock(Date.now() - entry.at)})`)
    }
    return entry
  }
  const settle = async (token: string, response: "once" | "always" | "reject") => {
    const entry = await close(token, VERDICT[response])
    if (!entry) return
    const ok = await reply(entry.sessionID, entry.permissionID, response)
    if (!ok) {
      const stream = chats.get(entry.chatID)?.stream
      if (stream) {
        stream.decisions.push(`⚠️ ${entry.label} · opencode не принял ответ (запрос мог уже закрыться)`)
        schedule(entry.chatID)
      } else await send(entry.chatID, `⚠️ ${VERDICT[response]}, но opencode не принял ответ — запрос мог уже закрыться.`).catch(() => {})
    }
  }

  const normalize = (p: Record<string, any> | undefined) => {
    if (!p?.id || !p?.sessionID) return undefined
    const type = String(p.type ?? p.permission ?? "permission")
    const pattern = p.pattern ?? p.patterns
    const title = p.title || p.metadata?.description || p.metadata?.title || `Разрешить ${type}?`
    return { id: String(p.id), sessionID: String(p.sessionID), type, title: String(title), pattern }
  }

  // Requests still waiting in opencode. Events can be missed (a restart, a reconnect, a
  // format this plugin did not know): this catches whatever the event stream did not.
  const auth = process.env.OPENCODE_SERVER_PASSWORD
    ? { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` }
    : {}
  const reconcile = async () => {
    try {
      const url = new URL(`/permission?directory=${encodeURIComponent(directory)}`, serverUrl)
      const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return log("warn", `permission list ${url.origin}: HTTP ${res.status}`)
      const list = (await res.json()) as Record<string, any>[]
      const ours = list.filter((p) => sessions.has(p.sessionID) && !asked.has(p.id)).length
      if (ours) log("info", `permission list: ${ours} unanswered request(s) without a button, sending`)
      for (const raw of list) {
        const perm = normalize(raw)
        if (perm && sessions.has(perm.sessionID) && !asked.has(perm.id)) await askPermission(perm)
      }
    } catch (err) {
      log("warn", `permission list: ${String(err)}`)
    }
  }

  const onEvent = async (raw: unknown) => {
    const payload = ((raw as { payload?: unknown }).payload ?? raw) as { type: string; properties?: Record<string, any> }
    const props = payload.properties
    if (debug) log("debug", `event ${payload.type} keys=${Object.keys(props || {}).join(",")}`)
    const sessionID: string | undefined = props?.sessionID ?? props?.part?.sessionID ?? props?.info?.sessionID
    if ((payload.type === "permission.updated" || payload.type === "permission.asked") && sessionID) {
      // permission.asked is the current shape (permission, patterns); permission.updated the old one (type, title, pattern)
      const perm = normalize(props)
      if (perm && sessions.has(perm.sessionID)) await askPermission(perm)
      return
    }
    if (payload.type === "message.part.delta") {
      // opencode 1.18 streams text and reasoning as deltas; message.part.updated only marks a
      // part's start and end, so without this the thinking message froze after one update
      const target = sessionID ? sessions.get(sessionID) : undefined
      const stream = target !== undefined ? chats.get(target)?.stream : undefined
      if (!stream || !props?.partID || typeof props.delta !== "string") return
      if (props.field && props.field !== "text") return
      touch(target!)
      if (otherParts.has(props.partID)) return   // a tool's output or code: never shown as thinking
      const piece = stream.pieces.get(props.partID)
      if (piece) piece.text += props.delta
      else {
        // a delta before the part's own event: kept hidden until message.part.updated says what it is
        stream.pieces.set(props.partID, { message: String(props.messageID ?? ""), kind: "reasoning", text: props.delta, pending: true })
      }
      schedule(target!)
      return
    }
    if (payload.type === "message.part.removed") {
      const target = sessionID ? sessions.get(sessionID) : undefined
      if (target !== undefined && props?.partID) chats.get(target)?.stream?.pieces.delete(props.partID)
      return
    }
    if (payload.type === "permission.replied" && sessionID) {
      const answered = props?.permissionID ?? props?.requestID
      const how = String(props?.reply ?? props?.response ?? "")
      for (const [token, entry] of pending) {
        if (entry.sessionID !== sessionID || entry.permissionID !== answered) continue
        await close(token, `${VERDICT[how as keyof typeof VERDICT] ?? "Ответ получен"} (в другом окне)`)
      }
      return
    }
    if (payload.type === "message.updated" && props?.info?.role === "user" && props.info.id) {
      userMessages.add(props.info.id)
      if (userMessages.size > 500) userMessages.delete(userMessages.values().next().value as string)
      return
    }
    const chatID = sessionID ? sessions.get(sessionID) : undefined
    if (chatID === undefined) return
    touch(chatID)
    if (payload.type === "message.part.updated" && userMessages.has(props?.part?.messageID)) return
    const owner = chat(chatID)
    if (!owner.stream && payload.type === "message.part.updated") {
      // A run this process did not start (it was running before a restart): pick up its
      // output so it still reaches the chat.
      owner.busy = true
      owner.stream = { pieces: new Map(), messages: [], steps: [], decisions: [], sent: "", started: Date.now() }
    }
    const stream = owner.stream
    if (!stream) return
    if (payload.type === "message.part.updated") {
      const part = props?.part
      if (!part) return
      if (part.type === "text" || part.type === "reasoning") {
        if (part.synthetic) return
        const message = String(part.messageID ?? "")
        if (message && !stream.messages.includes(message)) stream.messages.push(message)
        // the part's full text wins over the deltas collected so far, unless it is still shorter
        const had = stream.pieces.get(part.id)
        const text = part.text ?? ""
        stream.pieces.set(part.id, { message, kind: part.type, text: had && had.text.length > text.length ? had.text : text })
        schedule(chatID)
      } else {
        otherParts.add(part.id)
        if (otherParts.size > 2000) otherParts.delete(otherParts.values().next().value as string)
        stream.pieces.delete(part.id)   // deltas that arrived before we knew it was a tool
      }
      if (part.type === "tool") {
        const title = part.state?.title
        if (title && stream.steps.at(-1) !== title) {
          stream.steps.push(title)
          if (stream.steps.length > 8) stream.steps = stream.steps.slice(-8)
          schedule(chatID)
        }
      }
    } else if (payload.type === "session.error") {
      // an abort (/stop, the stuck watchdog) already says so in the message
      if (props?.error?.name === "MessageAbortedError") return
      stream.error = props?.error?.data?.message || props?.error?.name || "unknown"
      schedule(chatID)
    } else if (payload.type === "session.idle") {
      await finish(chatID)
    }
  }

  const watchEvents = async () => {
    while (running) {
      try {
        const { stream } = await client.event.subscribe()
        log("info", "event stream connected")
        for await (const raw of stream) await onEvent(raw)
        log("warn", "event stream closed, reconnecting in 3s")
      } catch (err) {
        log("error", `event stream: ${String(err)}`)
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  const gate = async (chatID: number, userID: number | undefined, text: string) => {
    if (BUTTONS[text.trim()]) {
      // a leftover command button is not a password attempt
      return send(chatID, "🔒 Сначала войдите: отправьте пароль сообщением.", { remove_keyboard: true }).catch(() => {})
    }
    const rec = attempts.get(chatID)
    if (rec?.until && rec.until > Date.now()) {
      const mins = Math.ceil((rec.until - Date.now()) / 60_000)
      return send(chatID, `⏳ Слишком много попыток. Повторите через ${mins} мин.`).catch(() => {})
    }
    if (!pass) {
      log("warn", `no TELEGRAM_PASSWORD set, refusing chat ${chatID}`)
      return send(chatID, "🔒 Бот закрыт: пароль не настроен на сервере.").catch(() => {})
    }
    const candidate = text.replace(/^\/password\s*/i, "").trim()
    if (candidate && same(candidate, pass)) {
      users.add(chatID)
      if (userID) users.add(userID)
      saveUsers()
      attempts.delete(chatID)
      log("info", `granted access to chat ${chatID} user ${userID}`)
      return send(chatID, "✅ Доступ разрешён. Пишите задачу — кнопки команд под полем ввода.", KEYBOARD).catch(() => {})
    }
    const n = (rec?.n || 0) + 1
    if (n >= 5) {
      attempts.set(chatID, { n: 0, until: Date.now() + 10 * 60_000 })
      return send(chatID, "🚫 Слишком много попыток. Блокировка на 10 минут.").catch(() => {})
    }
    attempts.set(chatID, { n, until: 0 })
    log("warn", `bad password from chat ${chatID} user ${userID} (${n}/5)`)
    return send(chatID, `🔒 Нужен пароль. Отправьте его сообщением или /password <пароль>\nОсталось попыток: ${5 - n}`).catch(() => {})
  }

  let polls = 0
  const poll = async () => {
    while (running) {
      try {
        const updates = await call<{ update_id: number; message?: any; callback_query?: any }[]>("getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        })
        for (const update of updates || []) {
          offset = Math.max(offset, update.update_id + 1)
          const cb = update.callback_query
          if (cb) {
            const [kind, token, verdict] = String(cb.data || "").split(":")
            if (kind === "s") {
              void onSettings(cb, token, verdict).catch((err) => log("error", `settings: ${String(err)}`))
              continue
            }
            const live = kind === "p" && pending.has(token) && verdict in VERDICT
            await call("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: live ? `${VERDICT[verdict as keyof typeof VERDICT]} — принято` : "Этот запрос уже закрыт",
            }).catch(() => {})
            if (live) {
              void settle(token, verdict as "once" | "always" | "reject").catch((err) => log("error", `settle: ${String(err)}`))
            } else if (cb.message?.chat?.id && cb.message?.message_id) {
              // a button from before a restart or already answered: drop the buttons so it stops inviting clicks
              await edit(cb.message.chat.id, cb.message.message_id, `${cb.message.text ?? "🔐"}\n\n⌛ Запрос уже закрыт.`).catch(() => {})
            }
            continue
          }
          const msg = update.message
          if (!msg?.chat?.id || typeof msg.text !== "string") continue
          const chatID = msg.chat.id as number
          const userID = msg.from?.id as number | undefined
          if (!users.has(chatID) && !(userID && users.has(userID))) {
            await gate(chatID, userID, msg.text)
            continue
          }
          // Not awaited: a prompt runs for minutes, and the poll loop has to keep taking
          // buttons, /stop, passwords and other chats in the meantime.
          void (async () => {
            await call("sendChatAction", { chat_id: chatID, action: "typing" }).catch(() => {})
            await handle(chatID, msg.text)
          })().catch(async (err) => {
            log("error", `chat ${chatID}: ${String(err)}`)
            await send(chatID, `❌ ${String(err)}`).catch(() => {})
          })
        }
      } catch (err) {
        // a dropped connection is routine on a long poll: retry at once, back off only on repeats
        polls = Math.min(polls + 1, 6)
        if (polls > 2) log("error", `poll: ${String(err)}`)
        await new Promise((r) => setTimeout(r, polls > 2 ? 5000 : 1000))
        continue
      }
      polls = 0
    }
  }

  const checkModel = async () => {
    const model = fallbackModel
    if (!model?.includes("/")) return
    const providerID = model.split("/")[0]
    try {
      const cfg = await client.config.get({ query: { directory } })
      const provider = (cfg.data as any)?.provider?.[providerID]
      const baseURL = provider?.options?.baseURL as string | undefined
      if (!baseURL) return log("warn", `no baseURL for provider ${providerID}, skipping reachability check`)
      const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
        signal: AbortSignal.timeout(5000),
      }).catch((err) => {
        throw new Error(String(err))
      })
      if (res.status === 401 || res.status === 403) {
        log("info", `model endpoint ${baseURL} reachable (auth required, HTTP ${res.status})`)
      } else {
        log(res.ok ? "info" : "warn", `model endpoint ${baseURL} -> HTTP ${res.status}`)
      }
    } catch (err) {
      log("error", `model endpoint unreachable (${providerID}): ${String(err)}`)
    }
  }

  const watchdog = async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 30_000))
      await reconcile()
      for (const [chatID, state] of chats) {
        if (!state.busy || !state.sessionID) continue
        if ([...pending.values()].some((p) => p.chatID === chatID)) continue
        if (Date.now() - state.touched < STUCK_MS) continue
        log("warn", `session ${state.sessionID} stuck, aborting`)
        await client.session.abort({ query: { directory }, path: { id: state.sessionID } }).catch(() => {})
        if (state.stream) state.stream.error = `Ответ завис (${clock(STUCK_MS)} без событий) — прервано. Напишите ещё раз.`
        await finish(chatID)
      }
    }
  }

  const heartbeat = async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
      // not awaited: one slow edit must not hold back the others or the next tick
      for (const [chatID, state] of chats) if (state.busy && state.stream) void flush(chatID).catch(() => {})
      for (const [token, entry] of pending) {
        const waited = Date.now() - entry.at
        if (waited >= entry.ttl) {
          log("warn", `permission ${entry.permissionID} timed out, default ${entry.fallback}`)
          void (async () => {
            await close(token, `⏱️ Время вышло — ${entry.fallback === "once" ? "разрешено по умолчанию" : "отклонено по умолчанию"}`)
            await reply(entry.sessionID, entry.permissionID, entry.fallback)
          })().catch((err) => log("error", `timeout reply: ${String(err)}`))
          continue
        }
        if (Date.now() - entry.refreshed < (entry.ttl <= 60_000 ? 5_000 : 15_000)) continue
        entry.refreshed = Date.now()
        const shown = countdown(entry.text, waited, entry.ttl, entry.fallback)
        if (shown === entry.shown) continue
        entry.shown = shown
        void edit(entry.chatID, entry.messageID, shown, entry.keyboard).catch(() => {})
      }
    }
  }

  const boot = async () => {
    await call("setMyCommands", { commands: MENU }).catch((err) => log("warn", `setMyCommands: ${String(err)}`))
    await call("getMe", {})
      .then((me: any) =>
        log(
          "info",
          `telegram bridge ready as @${me.username} agent=${agent} dir=${directory} users=${users.size} password=${pass ? "yes" : "no"} stuck=${STUCK_MS / 60_000}m permission=${PERMISSION_MS / 60_000}m`,
        ),
      )
      .catch((err) => log("error", `getMe: ${String(err)}`))
    await checkModel()
    await reconcile()
    void watchEvents().catch((err) => log("error", `event stream: ${String(err)}`))
    void watchdog()
    void heartbeat()
  }

  const supervise = async () => {
    await new Promise((r) => setTimeout(r, 50))
    void boot()
    while (running) {
      if (!polling && acquire()) {
        polling = true
        log("info", "acquired telegram poll lock, starting updates")
        void poll()
      }
      await new Promise((r) => setTimeout(r, 15_000))
    }
  }

  void supervise()

  return {
    dispose: async () => {
      running = false
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      if (!polling) return
      try {
        unlinkSync(lock)
      } catch {}
    },
  }
}) satisfies Plugin
