# OpenClaw Memory (Cognee)

Knowledge graph memory powered by [Cognee](https://github.com/topoteretes/cognee).

Unlike flat vector stores that return isolated snippets, Cognee builds a **connected knowledge graph** that understands relationships between entities. When you search, you get not just matching text but related concepts and their connections.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  OpenClaw Plugin (TypeScript)               │
│                                                             │
│  Tools: cognee_search, cognee_store, cognee_explore         │
│  Hooks: auto-recall, auto-capture                           │
│  CLI: openclaw cognee status/search/add/explore             │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/REST
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cognee Bridge (Python)                     │
│                                                             │
│  - Entity extraction (NER)                                  │
│  - Relationship detection                                   │
│  - Knowledge graph construction                             │
│  - Vector + graph hybrid search                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **Python 3.10+** with pip
2. **Cognee** installed: `pip install cognee`
3. **LLM API key** (OpenAI recommended for entity extraction)

## Installation

### 1. Install Python dependencies

```bash
cd extensions/memory-cognee/bridge
pip install -r requirements.txt
```

### 2. Configure OpenClaw

In your `openclaw.config.json`:

```json
{
  "plugins": ["@openclaw/memory-cognee"],
  "memory-cognee": {
    "cogneeUrl": "http://localhost:8000",
    "llmProvider": "openai",
    "llmApiKey": "sk-...",
    "llmModel": "gpt-4o-mini",
    "autoRecall": true,
    "autoCapture": true,
    "autoCognify": true,
    "graphDepth": 2
  }
}
```

### 3. Start the bridge (automatic or manual)

**Automatic**: The plugin will start the bridge server automatically.

**Manual** (recommended for production):
```bash
cd extensions/memory-cognee/bridge
COGNEE_LLM_API_KEY=sk-... python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

## How It Works

### Adding Knowledge

When you store information:

```
User: "Remember that I prefer dark mode and use TypeScript for all projects"
```

Cognee:
1. **Extracts entities**: `dark mode`, `TypeScript`, `projects`
2. **Detects relationships**: `user PREFERS dark mode`, `user USES TypeScript`
3. **Builds graph**: Connects these to existing knowledge

### Searching Knowledge

When you query:

```
User: "What do I use for projects?"
```

Cognee:
1. **Vector search**: Finds semantically similar content
2. **Graph traversal**: Follows relationships to find connected knowledge
3. **Returns context**: Both direct matches AND related concepts

Result includes:
- "I prefer dark mode and use TypeScript for all projects"
- Related entities: `TypeScript`, `dark mode`
- Relationships: `PREFERS`, `USES`

### Context Injection

Before each agent turn, relevant knowledge is automatically injected:

```xml
<knowledge-context>
This context is retrieved from a knowledge graph...

1. [preference] I prefer dark mode and use TypeScript
   → Related: TypeScript (language), dark mode (setting)
   → Links: PREFERS → dark mode; USES → TypeScript

2. [fact] TypeScript projects should use strict mode
   → Related: TypeScript (language), strict mode (config)
</knowledge-context>
```

## Tools

### `cognee_search`
Search the knowledge graph with relationship context.

```
Agent uses cognee_search with query "TypeScript configuration"
→ Returns matches + related entities + relationship paths
```

### `cognee_store`
Store information and automatically build knowledge graph.

```
Agent uses cognee_store with text "We decided to use PostgreSQL for the database"
→ Extracts: PostgreSQL (database), decision
→ Links to existing project knowledge
```

### `cognee_explore`
Explore relationships around a specific concept.

```
Agent uses cognee_explore with entity "PostgreSQL"
→ Returns graph: PostgreSQL --[STORES]--> user_data
                 PostgreSQL --[CONNECTS_TO]--> backend_api
```

### `cognee_forget`
GDPR-compliant deletion.

## CLI Commands

```bash
# Check status
openclaw cognee status

# Search
openclaw cognee search "project preferences"

# Add knowledge
openclaw cognee add "Important: always use ESLint" --source manual

# Rebuild graph
openclaw cognee cognify --full

# Explore entity
openclaw cognee explore "TypeScript" --depth 3
```

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cogneeUrl` | string | `http://localhost:8000` | Bridge server URL |
| `llmProvider` | enum | `openai` | LLM for entity extraction |
| `llmApiKey` | string | - | API key for LLM |
| `llmModel` | string | `gpt-4o-mini` | Model for extraction |
| `embeddingProvider` | enum | `openai` | Embedding provider |
| `embeddingModel` | string | `text-embedding-3-small` | Embedding model |
| `graphStore` | enum | `networkx` | Graph backend |
| `vectorStore` | enum | `lancedb` | Vector backend |
| `dataDir` | string | `~/.openclaw/memory/cognee` | Data directory |
| `autoRecall` | boolean | `true` | Auto-inject context |
| `autoCapture` | boolean | `true` | Auto-store important info |
| `autoCognify` | boolean | `true` | Auto-build graph |
| `searchLimit` | number | `5` | Max search results |
| `searchMinScore` | number | `0.3` | Min relevance score |
| `graphDepth` | number | `2` | Relationship traversal depth |
| `captureMaxChars` | number | `500` | Max capture text length |

## Comparison: Cognee vs LanceDB

| Feature | memory-cognee | memory-lancedb |
|---------|---------------|----------------|
| Storage | Knowledge graph + vectors | Flat vector entries |
| Relationships | Automatic entity linking | None |
| Query | Graph + semantic search | Vector similarity only |
| Context | Connected knowledge | Isolated snippets |
| Setup | Requires Python bridge | Pure TypeScript |
| Dependencies | Cognee, FastAPI, LLM | LanceDB, OpenAI |

## Troubleshooting

### Bridge won't start
- Check Python version: `python --version` (needs 3.10+)
- Check Cognee installed: `python -c "import cognee; print(cognee.__version__)"`
- Check port available: `lsof -i :8000`

### No results from search
- Run `openclaw cognee cognify` to build the graph
- Check `openclaw cognee status` for document count
- Lower `searchMinScore` in config

### Slow performance
- Use a smaller LLM model (`gpt-4o-mini` vs `gpt-4`)
- Reduce `graphDepth` for faster queries
- Use local embeddings if latency is critical

## License

MIT
