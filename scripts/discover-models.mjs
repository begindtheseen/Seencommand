#!/usr/bin/env node
import { discoverModels } from '../intelligence/model-registry.mjs';
console.log(JSON.stringify(discoverModels(), null, 2));
