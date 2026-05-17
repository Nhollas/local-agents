workspace "local-agents" "C4 model for the local-agents orchestrator and dashboard" {

    !identifiers hierarchical
    !impliedRelationships true

    model {
        engineer = person "Engineer" "Files issues, watches runs, reviews change requests."

        jira       = softwareSystem "Jira"                    "Issue tracker — source of truth for what work exists."                                               "External"
        codehost   = softwareSystem "GitHub / GitLab"     "Clone URLs, default branches, change requests."                                                  "External"
        claude     = softwareSystem "Claude Agent SDK"    "query() per workflow step."                                                                       "External"
        langfuse   = softwareSystem "Langfuse"            "OTel traces, cost and token telemetry."                                                           "External"
        databricks = softwareSystem "Databricks Model Serving" "OpenAI-compatible inference gateway; rate limiting, usage tracking, per-team spend caps."    "External"
        gitlab     = softwareSystem "GitLab"              "Clone URLs, default branches, merge requests."                                                    "External"

        localAgents = softwareSystem "local-agents" "Polling orchestrator + dashboard running on the engineer's machine." {

            dashboard = container "Dashboard" "Live view of queue, runs, transcripts; kill controls." "React + Vite SPA" "WebApp"

            orchestrator = container "Orchestrator" "Polls tracker, dispatches runs, owns run lifecycle, serves API + SSE." "Node.js (Hono)" {
                api          = component "HTTP API"          "Exposes run state and controls to the dashboard."
                eventbus     = component "Event bus"         "Broadcasts run and step events to subscribers."
                loop         = component "Orchestrator loop" "Decides what to dispatch on each tick."
                runner       = component "Runner"            "Bounded concurrency pool that owns active runs."
                lifecycle    = component "Run lifecycle"     "Drives one run through the fixed pins (clone → steps → push → CR → transition)."
                workspace    = component "Workspace manager" "Owns the per-run filesystem: clone, setup, cleanup."
                workflow     = component "Workflow engine"   "Loads the workflow; renders prompts; expands trusted blocks."
                agent        = component "Agent invoker"     "Wraps the Claude Agent SDK; manages hooks, logging, metrics."
                tracker      = component "Issue tracker adapter" "Talks to the issue tracker."
                forgeAdapter = component "Code-host adapter" "Talks to the code host."
                repo         = component "Run repository"    "Persists runs, steps, events, and step outputs."
                telemetry    = component "Telemetry"         "Exports spans, cost, and token usage to Langfuse."

                api       -> loop      "Observes queue"
                api       -> runner    "Cancels runs"
                api       -> repo      "Reads history"
                api       -> eventbus  "Subscribes"

                loop      -> tracker   "Polls + reconciles"
                loop      -> repo      "Reads/writes running snapshot"
                loop      -> runner    "Dispatches"

                runner    -> lifecycle "Drives"
                runner    -> eventbus  "Publishes"
                runner    -> repo      "Records"

                lifecycle -> workspace    "Prepares"
                lifecycle -> workflow     "Renders steps via"
                lifecycle -> agent        "Invokes per step"
                lifecycle -> forgeAdapter "Publishes via"
                lifecycle -> tracker      "Transitions via"
                lifecycle -> telemetry    "Wraps run + step in spans"

                agent     -> telemetry "Reports SDK metrics to"
            }

            db         = container "Run store"  "Runs, steps, events, step outputs."         "SQLite via Drizzle" "Database"
            mongoDb    = container "Run store (MongoDB)" "Runs, steps, events, step outputs." "MongoDB"            "Database"
            workspaces = container "Workspaces" "Per-run git clones; preserved on failure."  "Filesystem"         "Filesystem"

            agentSandbox = container "Agent Sandbox" "Ephemeral Firecracker VM per run. Receives the job spec, runs the agent process against the workspace, and returns a structured result on exit." "Firecracker VM" {
                agentProcess = component "Agent process" "Runs Claude Agent SDK. Executes tools (Read, Write, Edit, Bash, Git) against the workspace; streams events back to the orchestrator." "Node.js + Claude Agent SDK"
                sandboxFs    = component "Workspace"     "Ephemeral git clone of the target repository. Destroyed on successful completion; preserved on failure for inspection." "Filesystem"
                agentProcess -> sandboxFs "Reads/writes files"
            }

            dashboard                        -> orchestrator     "Reads runs/queue/stats; subscribes to events" "REST + SSE"
            orchestrator.repo                -> db               "Reads/writes"                                 "Drizzle"
            orchestrator.repo                -> mongoDb          "Reads/writes"                                 "MongoDB driver"
            orchestrator.workspace           -> workspaces       "Clones + cleanup"
            orchestrator.workspace           -> agentSandbox     "Provisions + destroys"                        "Firecracker / EKS API"
            orchestrator.agent               -> agentSandbox     "Submits job spec; collects result"            "HTTP"
            agentSandbox.agentProcess        -> databricks       "Model inference"                              "HTTPS (OpenAI-compatible)"
        }

        engineer -> localAgents.dashboard "Monitors runs" "HTTPS"
        engineer -> jira                  "Files issues, reviews state"
        engineer -> codehost              "Reviews change requests"

        localAgents.orchestrator.tracker      -> jira     "REST"
        localAgents.orchestrator.forgeAdapter -> codehost "REST + git"
        localAgents.orchestrator.forgeAdapter -> gitlab   "REST + git"
        localAgents.orchestrator.agent        -> claude   "query()"                               "SDK"
        localAgents.orchestrator.telemetry    -> langfuse "OTLP"
    }

    views {
        container localAgents "containers" {
            include *
            exclude engineer->jira
            exclude engineer->codehost
            exclude localAgents.agentSandbox
            exclude databricks
            exclude gitlab
            exclude localAgents.mongoDb
            autolayout tb
        }

        container localAgents "production-containers" "Production topology: Firecracker sandboxes per run, Databricks Model Serving as the inference gateway, GitLab as the code host, MongoDB as the run store." {
            include *
            exclude engineer->jira
            exclude claude
            exclude codehost
            exclude localAgents.db
            exclude localAgents.workspaces
            exclude localAgents.orchestrator.workspace->localAgents.workspaces
            autolayout tb
        }

        component localAgents.orchestrator "orchestrator-components" {
            include *
            exclude localAgents.agentSandbox
            autolayout tb
        }

        dynamic localAgents.orchestrator "run-lifecycle" "Walks one run from poll to transition." {
            localAgents.orchestrator.loop         -> localAgents.orchestrator.tracker      "Polls issue tracker for ready issues"
            localAgents.orchestrator.loop         -> localAgents.orchestrator.runner       "Dispatches a run"
            localAgents.orchestrator.runner       -> localAgents.orchestrator.lifecycle    "Drives the run"
            localAgents.orchestrator.lifecycle    -> localAgents.orchestrator.workspace    "Clones repo and runs setup"
            localAgents.orchestrator.lifecycle    -> localAgents.orchestrator.workflow     "Renders prompts for each step"
            localAgents.orchestrator.lifecycle    -> localAgents.orchestrator.agent        "Invokes Claude per step"
            localAgents.orchestrator.lifecycle    -> localAgents.orchestrator.forgeAdapter "Pushes branch and opens CR"
            localAgents.orchestrator.lifecycle    -> localAgents.orchestrator.tracker      "Transitions issue"
            autolayout lr
        }

        styles {
            element "Person" {
                shape Person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "WebApp" {
                shape WebBrowser
            }
            element "Database" {
                shape Cylinder
            }
            element "Filesystem" {
                shape Folder
                background #6db33f
                color #ffffff
            }
            element "Firecracker VM" {
                shape RoundedBox
                background #e05c00
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
        }
    }
}
