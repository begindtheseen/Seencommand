# Model strategy

The actual Mac is Apple M5 Pro with 48 GB unified memory. Ollama 0.31.1 and Qwen2.5 Coder 14B/32B are
already installed. The runtime discovers them from `ollama list`; it never treats catalog entries as
installed and never downloads a model.

Tier A uses the 14B model for classification, summaries, ranking queries, metadata, small plans, and
small structured edits. Tier B uses the 32B model for harder planning, code, debugging, independent
review, and security reasoning. Tier C is disabled by default. A remote model can be enabled only by
configuration and still must pass privacy, capability, dollar, retry, and approval checks.

Model records include identity/family/version, provider/runtime, quantization, parameter counts,
context, estimated memory, measured latency/tokens per second, capabilities, license/source,
installation/health, evaluation score, and benchmark timestamp. Null measured values mean “not
measured,” never a guess.

Run `npm run intelligence:models` for discovery and `npm run intelligence:benchmark --
qwen2.5-coder-14b` for a small real benchmark. Benchmarking does not install or download anything.
