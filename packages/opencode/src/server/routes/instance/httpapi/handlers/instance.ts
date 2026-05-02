import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      return { branch, default_branch }
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: { query: { mode: Vcs.Mode } }) {
      return yield* vcs.diff(ctx.query.mode)
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsDiff", getVcsDiff)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)

export const transcribeRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "POST",
      "/transcribe",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const source = req.source instanceof Request ? req.source : undefined
        if (!source) {
          return HttpServerResponse.json({ error: "Invalid request" }, { status: 400 })
        }
        const formData = yield* Effect.promise(() => source.formData())
        const audio = formData.get("audio")
        if (!(audio instanceof File)) {
          return HttpServerResponse.json({ error: "Missing audio file" }, { status: 400 })
        }

        const apiKey = process.env.GROQ_API_KEY
        if (!apiKey) {
          return HttpServerResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 400 })
        }

        const groqForm = new FormData()
        groqForm.append("file", audio)
        groqForm.append("model", "whisper-large-v3-turbo")

        const res = yield* Effect.promise(() =>
          fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: groqForm,
          }),
        )

        if (!res.ok) {
          const text = yield* Effect.promise(() => res.text().catch(() => "Unknown error"))
          return HttpServerResponse.json({ error: `Groq API error: ${text}` }, { status: 502 })
        }

        const data = (yield* Effect.promise(() => res.json())) as { text?: string }
        return HttpServerResponse.json({ text: data.text ?? "" })
      }),
    )
  }),
)
