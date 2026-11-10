import { createNodeKernel } from '../../dist/node.js';
import { oauthDeviceTests } from './sealed-oauth-fixture.mjs';

oauthDeviceTests(createNodeKernel);
