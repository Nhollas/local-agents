# Diagrams

C4 diagrams for the codebase. `workspace.dsl` is the source of truth; the SVGs are generated output, committed so the docs render anywhere without tooling.

## Files

- `workspace.dsl` — Structurizr DSL describing the full C4 model.
- `regen.sh` — regenerates the SVGs from the DSL.
- `structurizr-containers.svg` — containers inside the local-agents boundary and their links to external systems.
- `structurizr-orchestrator-components.svg` — orchestrator components and their responsibilities.
- `structurizr-run-lifecycle.svg` — dynamic view walking one run from poll to transition.

## Iterating quickly

Run [Structurizr Lite](https://docs.structurizr.com/lite) in Docker against this directory:

```sh
docker run -it --rm -p 8080:8080 -v "$PWD":/usr/local/structurizr structurizr/lite
```

Open <http://localhost:8080>. Edit `workspace.dsl`, save, refresh the browser — diagrams update immediately. You can also drag nodes manually and click "save layout" to persist positions back into the workspace.

When you're done, export SVGs from the Lite UI, or run `./regen.sh` to regenerate them via the CLI pipeline.

## Regenerating from the CLI

One-off install:

```sh
brew install structurizr-cli plantuml
```

Then from this directory:

```sh
./regen.sh
```

The script exports the DSL to PlantUML, injects `!pragma layout elk` to switch PlantUML's layout engine from Graphviz to ELK (much better at minimising edge crossings on C4 diagrams), and renders to SVG.

## Editing the model

Edit `workspace.dsl` and regenerate. The DSL holds the entire model (people, systems, containers, components, relationships) once; each `view` block in the `views` section selects what to show. To add a new view, add another block — don't duplicate elements.
