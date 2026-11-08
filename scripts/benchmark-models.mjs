#!/usr/bin/env node
import { benchmarkOllama, discoverModels, recordBenchmark } from '../intelligence/model-registry.mjs';
const id = process.argv[2] || 'qwen2.5-coder-14b';
const model = discoverModels().models.find((m) => m.id === id && m.installationStatus === 'installed');
if (!model) { console.error(`Installed model not found: ${id}. This command never downloads models.`); process.exit(1); }
const result = await benchmarkOllama(model); recordBenchmark(result); console.log(JSON.stringify(result, null, 2));
