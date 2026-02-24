# Running Graphiti MCP Server with Local Models

This guide explains how to run the Graphiti MCP server with fully local models (Ollama, vLLM, etc.) for privacy-focused or cost-controlled deployments.

## Current Status

**Important**: Local model support requires changes that are currently pending upstream merge.

- **Issue**: [getzep/graphiti#1226](https://github.com/getzep/graphiti/issues/1226)
- **Pull Request**: [getzep/graphiti#1227](https://github.com/getzep/graphiti/pull/1227) (Draft)
- **Fork with changes**: [Contextable/graphiti](https://github.com/Contextable/graphiti)

Until the PR is merged into the upstream repository, you have two options:

### Option 1: Use the Fork (Recommended)

Use our fork which includes the local model support:

```bash
# Clone the fork
git clone https://github.com/Contextable/graphiti.git
cd graphiti/mcp_server
```

### Option 2: Apply the PR to Upstream

If you prefer to use the official repository:

1. Clone the upstream repository
2. Apply the changes from PR #1227 manually
3. Or wait for the PR to be merged

## What's Included

The local model support adds:

1. **`openai_generic` LLM Provider**
   - For OpenAI-compatible endpoints (Ollama, vLLM, LM Studio, LocalAI)
   - Optimized for local models (16K vs 8K token limits)
   - No reasoning/verbosity parameters applied

2. **Reranker Configuration**
   - OpenAI reranker (default, requires API key)
   - Gemini reranker (requires API key)
   - BGE reranker (local, CPU-based, no API key needed)

3. **Full Environment Variable Support**
   - All configuration options can be set via environment variables

## Configuration

### Fully Local Setup (No Cloud Dependencies)

```yaml
llm:
  provider: "openai_generic"
  model: "deepseek-r1:7b"  # or your preferred Ollama model
  providers:
    openai:
      api_key: "not-needed"
      api_url: "http://localhost:11434/v1"

embedder:
  provider: "openai"
  model: "nomic-embed-text"
  dimensions: 768
  providers:
    openai:
      api_key: "not-needed"
      api_url: "http://localhost:11434/v1"

reranker:
  provider: "bge"  # Local, no API key needed
```

### Prerequisites

1. **Ollama** (for local LLM and embeddings)
   ```bash
   # Install Ollama
   curl -fsSL https://ollama.ai/install.sh | sh

   # Start Ollama
   ollama serve

   # Pull models
   ollama pull deepseek-r1:7b
   ollama pull nomic-embed-text
   ```

2. **Graph Database**
   - FalkorDB (default, included in Docker Compose)
   - Or Neo4j

### Running with Docker Compose

```bash
cd graphiti/mcp_server

# Create .env file
cat > .env <<EOF
# No API keys needed for fully local setup!
OPENAI_API_KEY=not-needed
OPENAI_API_URL=http://host.docker.internal:11434/v1
EOF

# Start the server
docker compose up
```

### Running Locally

```bash
cd graphiti/mcp_server

# Install dependencies
uv sync

# Set environment variables
export OPENAI_API_KEY=not-needed
export OPENAI_API_URL=http://localhost:11434/v1

# Run the server
uv run main.py --transport http
```

## Provider Selection Guide

### LLM Providers

- **openai** - Official OpenAI API with reasoning model support
- **openai_generic** - OpenAI-compatible endpoints (Ollama, vLLM, LM Studio)
- **azure_openai** - Azure OpenAI Service
- **anthropic** - Anthropic Claude API
- **gemini** - Google Gemini API
- **groq** - Groq API

### Reranker Providers

- **openai** - Uses OpenAI's LLM (default, requires API key)
- **gemini** - Uses Gemini's LLM (requires API key)
- **bge** - Local CPU-based reranker (no API key needed, fully local)

## Alternative: vLLM

For production deployments with higher throughput:

```yaml
llm:
  provider: "openai_generic"
  model: "meta-llama/Llama-3.3-70B-Instruct"
  providers:
    openai:
      api_key: "${VLLM_API_KEY}"
      api_url: "http://vllm-server:8000/v1"

embedder:
  provider: "openai"
  model: "nomic-embed-text:v1.5"
  dimensions: 768
  providers:
    openai:
      api_key: "not-needed"
      api_url: "http://localhost:11434/v1"

reranker:
  provider: "bge"
```

## Benefits of Local Deployment

✅ **Privacy & Compliance** - Data never leaves your infrastructure (HIPAA, GDPR compatible)
✅ **Cost Control** - No per-token charges, only infrastructure costs
✅ **Zero Cloud Dependencies** - Works in air-gapped environments
✅ **Custom Models** - Use fine-tuned models hosted on your infrastructure
✅ **Predictable Performance** - No rate limits or API throttling

## Testing

Run the configuration tests to verify your setup:

```bash
cd graphiti/mcp_server
uv run python tests/test_configuration.py
```

Expected output:
```
✓ Factory supports openai_generic provider for local models
⚠ Skipping OpenAI reranker test (no API key configured)
⚠ Skipping BGE reranker test (optional dependency not installed)
✓ All tests completed successfully!
```

## Troubleshooting

### Ollama Connection Issues

If the MCP server can't connect to Ollama:

1. Ensure Ollama is running: `ollama list`
2. Check the API URL is correct (use `host.docker.internal` in Docker)
3. Verify models are pulled: `ollama pull deepseek-r1:7b`

### BGE Reranker Issues

BGE requires sentence-transformers. Install with:

```bash
uv add graphiti-core[sentence-transformers]
```

### Performance Tuning

Adjust concurrency based on your hardware:

```bash
# Default: 10 concurrent operations
export SEMAPHORE_LIMIT=5  # Lower for slower hardware

# Higher for powerful machines
export SEMAPHORE_LIMIT=20
```

## Contributing

If you encounter issues with local model support:

1. Check the [issue tracker](https://github.com/getzep/graphiti/issues/1226)
2. Comment on the [pull request](https://github.com/getzep/graphiti/pull/1227)
3. Report problems in our fork's issues

## References

- [Graphiti Main Documentation](https://help.getzep.com/graphiti)
- [Ollama Documentation](https://ollama.ai/docs)
- [vLLM Documentation](https://docs.vllm.ai/)
- [Issue #1226: Support Local Model Deployments](https://github.com/getzep/graphiti/issues/1226)
- [PR #1227: Add local model support](https://github.com/getzep/graphiti/pull/1227)
