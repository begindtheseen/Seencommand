#!/usr/bin/env node
import { loadRuntimeConfig } from '../intelligence/runtime-config.mjs';
import { discoverModels } from '../intelligence/model-registry.mjs';
import { intelligenceRuntimeStatus } from '../intelligence/runtime-status.mjs';
import { WorkflowStore } from '../intelligence/workflow-store.mjs';
const config = loadRuntimeConfig(); const registry = discoverModels(); const workflows = new WorkflowStore().list();
const status = intelligenceRuntimeStatus({ config, registry, workflows });
const installed = registry.models.filter((m) => m.installationStatus === 'installed');
if (!installed.length) { console.error('No supported local model is installed. Runtime is prepared, but execution is blocked pending an approved model install.'); process.exit(1); }
console.log(JSON.stringify({ ok: true, installedModels: installed.map((m) => m.id), activeWorkflows: status.workflows.active, remoteEscalationEnabled: status.remoteEscalationEnabled, productionApprovalRequired: status.approvalBoundaries.production }, null, 2));
