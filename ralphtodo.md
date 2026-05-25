• The intended sequence was:

  ./ralph.sh measurement codex
  ./ralph.sh retrieval-ranking codex
  ./ralph.sh indexing-chunking codex
  ./ralph.sh integration-polish codex

  But those require these files to exist first:

  PROMPT-measurement.md
  PROMPT-retrieval-ranking.md
  PROMPT-indexing-chunking.md
  PROMPT-integration-polish.md

  The generic forms are:

  ./ralph.sh                   # uses PROMPT.md with Claude
  ./ralph.sh - codex           # uses PROMPT.md with Codex
  ./ralph.sh measurement       # uses PROMPT-measurement.md with Claude
  ./ralph.sh measurement codex # uses PROMPT-measurement.md with Codex