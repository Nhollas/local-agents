#!/usr/bin/env bash
# Regenerate SVG diagrams from workspace.dsl.
# Requires: structurizr-cli, plantuml (brew install structurizr-cli plantuml).

set -euo pipefail
cd "$(dirname "$0")"

structurizr-cli export -workspace workspace.dsl -format plantuml/c4plantuml

# Use ELK layout for the component and container diagrams (better at grouping
# related nodes and minimising edge crossings); leave the dynamic view on the
# default Graphviz, which renders left-to-right step sequences cleanly.
sed -i '' '2i\
!pragma layout elk
' structurizr-orchestrator-components.puml structurizr-containers.puml

plantuml -tsvg structurizr-*.puml
rm structurizr-*.puml

# structurizr-cli prefixes its output with `structurizr-`; drop it.
for f in structurizr-*.svg; do
  mv "$f" "${f#structurizr-}"
done

echo "Generated:"
ls -1 *.svg
