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

type Piece = { message: string; kind: "text" | "reasoning"; text: string }
type Stream = {
  // every text and reasoning part of the run, in arrival order, with the assistant message it belongs to
  pieces: Map<string, Piece>
  // assistant messages of this run in order: the last one carries the final answer
  messages: string[]
  steps: string[]
  error?: string
  sent: string
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
}
const KEYBOARD = {
  keyboard: [
    [{ text: "⏹ Стоп" }, { text: "🆕 Новая" }, { text: "⚡ Быстро" }],
    [{ text: "📊 Статус" }, { text: "📂 Сессии" }, { text: "❓ Помощь" }],
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
  { command: "permissions", description: "Подтверждения: ask | allow | deny" },
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
  const policy = (process.env.TELEGRAM_PERMISSIONS?.trim() || "ask") as "ask" | "allow" | "deny"
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
  const sessions = new Map<string, number>()
  const models = new Map<number, string>()
  const modes = new Map<number, "ask" | "allow" | "deny">()
  const fast = new Set<number>()
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
    const wait = method === "getUpdates" ? ((body.timeout as number) || 0) * 1000 + 15_000 : 30_000
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
      if (attempt < 3 && method !== "getUpdates") {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
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
  const pieces = (stream: Stream, kind: Piece["kind"]) => [...stream.pieces.values()].filter((p) => p.kind === kind && p.text.trim())
  const answerOf = (stream: Stream) => {
    const last = stream.messages.at(-1)
    return pieces(stream, "text").filter((p) => p.message === last).map((p) => p.text.trim()).join("\n\n")
  }
  const notesOf = (stream: Stream) => {
    const last = stream.messages.at(-1)
    return pieces(stream, "text").filter((p) => p.message !== last).map((p) => p.text.trim())
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
    const note = notesOf(stream).at(-1)
    const interim = note ? `\n📝 ${esc(note.length > 400 ? `…${note.slice(-400)}` : note)}` : ""
    const thought = pieces(stream, "reasoning").map((p) => p.text.trim()).join("\n\n")
    const quote = thought ? `\n<blockquote expandable>${esc(thought.length > 3000 ? `…${thought.slice(-3000)}` : thought)}</blockquote>` : ""
    const tail = stream.error ? `\n\n${esc(errorLine(stream))}` : ""
    return `${head}${steps}${interim}${quote}${tail}`
  }

  // Only ever edits the thinking message; a new one is sent only if there is none yet.
  const flush = async (chatID: number) => {
    const chat = chats.get(chatID)
    if (!chat?.stream) return
    const html = renderThinking(chat.stream)
    if (html === chat.stream.sent) return
    chat.stream.sent = html
    if (chat.stream.messageID) {
      await editHtml(chatID, chat.stream.messageID, html)
      return
    }
    chat.stream.messageID = await sendHtml(chatID, html)
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
    const answer = answerOf(stream)
    const thought = pieces(stream, "reasoning").length > 0 || stream.steps.length > 0 || notesOf(stream).length > 0
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
      state.stream = { pieces: new Map(), messages: [], steps: [], sent: "", started: Date.now() }
      state.stream.sent = renderThinking(state.stream)
      state.stream.messageID = await sendHtml(chatID, state.stream.sent)
      const idle = new Promise<void>((resolve) => (state.idle = resolve))
      const model = models.get(chatID) || fallbackModel
      const split = model?.includes("/") ? model.split("/") : undefined
      // "/no_think" at the end of a message is the model server's switch for a direct answer.
      const body = {
        agent,
        ...(split ? { model: { providerID: split[0], modelID: split.slice(1).join("/") } } : {}),
        parts: [{ type: "text" as const, text: fast.has(chatID) ? `${text} /no_think` : text }],
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
      models.delete(chatID)
      modes.delete(chatID)
      saveSessions()
      await send(chatID, "🆕 Новая сессия.")
    },
    "/stop": async (chatID) => {
      const state = chats.get(chatID)
      if (!state?.sessionID || !state.busy) return send(chatID, "Нечего прерывать.").then(() => {})
      await client.session.abort({ query: { directory }, path: { id: state.sessionID } })
      if (state.stream) state.stream.error = "🛑 Остановлено по вашей команде."
      await finish(chatID)
    },
    "/fast": async (chatID) => {
      if (fast.has(chatID)) fast.delete(chatID)
      else fast.add(chatID)
      await send(
        chatID,
        fast.has(chatID)
          ? "⚡ Быстрый режим: отвечаю без размышлений. Для сложных задач выключите: /fast"
          : "🧠 Обычный режим: с размышлениями (медленнее, но умнее).",
      )
    },
    "/model": async (chatID, arg) => {
      if (!arg) return send(chatID, `Модель: ${models.get(chatID) || fallbackModel || "из конфига"}`).then(() => {})
      models.set(chatID, arg)
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
          `Модель: ${models.get(chatID) || fallbackModel || "default"}`,
          `Режим: ${fast.has(chatID) ? "быстрый (без размышлений)" : "с размышлениями"}`,
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
      const next = arg.trim().toLowerCase()
      if (!next) {
        return send(chatID, `Разрешения: ${modes.get(chatID) || policy}\nВарианты: /permissions ask | allow | deny`).then(() => {})
      }
      if (next !== "ask" && next !== "allow" && next !== "deny") {
        return send(chatID, "Допустимо: ask, allow, deny").then(() => {})
      }
      modes.set(chatID, next)
      const hint = next === "allow" ? "Агент будет делать всё без подтверждений." : next === "deny" ? "Агент сможет только читать." : "Каждое опасное действие придёт кнопкой."
      await send(chatID, `Режим разрешений: ${next}\n${hint}`)
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

  const askPermission = async (perm: { id: string; sessionID: string; type: string; title: string; pattern?: string | string[] }) => {
    const chatID = sessions.get(perm.sessionID)
    if (chatID === undefined) return
    if (asked.has(perm.id)) return
    asked.add(perm.id)
    const mode = modes.get(chatID) || policy
    if (mode !== "ask") {
      log("info", `auto-${mode} permission ${perm.type} in chat ${chatID}`)
      await reply(perm.sessionID, perm.id, mode === "allow" ? "always" : "reject")
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
    const shown = `${text}\n\n⏳ ждёт ответа · отклонится само через ${clock(PERMISSION_MS)}`
    const sent = await send(chatID, shown, keyboard).catch(() => undefined)
    if (sent === undefined) {
      await reply(perm.sessionID, perm.id, "reject")
      return
    }
    pending.set(token, {
      sessionID: perm.sessionID,
      permissionID: perm.id,
      chatID,
      timer: setTimeout(() => {}, PERMISSION_MS),
      at: Date.now(),
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
    await edit(entry.chatID, entry.messageID, `${entry.text}\n\n${outcome} · ${hhmm()} (ждал ${clock(Date.now() - entry.at)})`)
    return entry
  }
  const settle = async (token: string, response: "once" | "always" | "reject") => {
    const entry = await close(token, VERDICT[response])
    if (!entry) return
    const ok = await reply(entry.sessionID, entry.permissionID, response)
    if (!ok) await edit(entry.chatID, entry.messageID, `${entry.text}\n\n⚠️ ${VERDICT[response]}, но opencode не принял ответ — запрос мог уже закрыться.`)
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
      owner.stream = { pieces: new Map(), messages: [], steps: [], sent: "", started: Date.now() }
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
        stream.pieces.set(part.id, { message, kind: part.type, text: part.text ?? "" })
        schedule(chatID)
      } else if (part.type === "tool") {
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
      for (const [token, entry] of pending) {
        if (Date.now() - entry.at < PERMISSION_MS) continue
        log("warn", `permission ${entry.permissionID} timed out, rejecting`)
        await close(token, "⏱️ Время вышло — отклонено")
        await reply(entry.sessionID, entry.permissionID, "reject")
      }
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
      for (const [chatID, state] of chats) if (state.busy && state.stream) await flush(chatID).catch(() => {})
      for (const entry of pending.values()) {
        if (Date.now() - entry.refreshed < 15_000) continue
        entry.refreshed = Date.now()
        const waited = Date.now() - entry.at
        const shown = `${entry.text}\n\n⏳ ждёт ответа ${clock(waited)} · отклонится само через ${clock(PERMISSION_MS - waited)}`
        if (shown === entry.shown) continue
        entry.shown = shown
        await edit(entry.chatID, entry.messageID, shown, entry.keyboard).catch(() => {})
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
