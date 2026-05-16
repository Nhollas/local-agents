workspace "local-agents" "C4 model for the local-agents orchestrator and dashboard" {

    !identifiers hierarchical
    !impliedRelationships true

    model {
        engineer = person "Engineer" "Files issues, watches runs, reviews change requests."

        jira     = softwareSystem "Jira"            "Issue tracker — source of truth for what work exists."  "External"
        codehost = softwareSystem "GitHub / GitLab" "Clone URLs, default branches, change requests."          "External"
        claude   = softwareSystem "Claude Agent SDK" "query() per workflow step."                             "External"
        langfuse = softwareSystem "Langfuse"        "OTel traces, cost and token telemetry."                  "External"

        localAgents = softwareSystem "local-agents" "Polling orchestrator + dashboard running on the engineer's machine." {

            dashboard = container "Dashboard" "Live view of queue, runs, transcripts; kill controls." "React + Vite SPA" "WebApp"

            orchestrator = container "Orchestrator" "Polls tracker, dispatches runs, owns run lifecycle, serves API + SSE." "Node.js (Hono + Claude Agent SDK)" {
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
            workspaces = container "Workspaces" "Per-run git clones; preserved on failure."  "Filesystem"         "Filesystem"

            dashboard               -> orchestrator     "Reads runs/queue/stats; subscribes to events" "REST + SSE"
            orchestrator.repo       -> db               "Reads/writes"                                 "Drizzle"
            orchestrator.workspace  -> workspaces       "Clones + cleanup"
        }

        engineer -> localAgents.dashboard "Monitors runs" "HTTPS"
        engineer -> jira                  "Files issues, reviews state"
        engineer -> codehost              "Reviews change requests"

        localAgents.orchestrator.tracker      -> jira     "REST"
        localAgents.orchestrator.forgeAdapter -> codehost "REST + git"
        localAgents.orchestrator.agent        -> claude   "query()"                               "SDK"
        localAgents.orchestrator.telemetry    -> langfuse "OTLP"
    }

    views {
        container localAgents "containers" {
            include *
            exclude engineer->jira
            exclude engineer->codehost
            autolayout tb
        }

        component localAgents.orchestrator "orchestrator-components" {
            include *
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
            element "Component" {
                background #85bbf0
                color #000000
            }
        }
    }
}
