#!/usr/bin/env node
import { detectHardware } from '../intelligence/model-registry.mjs';
console.log(JSON.stringify(detectHardware(), null, 2));
