#!/bin/bash
# Install Node.js dependencies for the graph generation pipeline.
# Run once before the first trend report. Subsequent runs are no-ops if node_modules exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRAPH_DIR="$SCRIPT_DIR/../graph-gen"

if [ -d "$GRAPH_DIR/node_modules" ]; then
  echo "graph-gen dependencies already installed, skipping."
  exit 0
fi

echo "Installing graph-gen dependencies..."
cd "$GRAPH_DIR" && npm install --production
echo "Done."
