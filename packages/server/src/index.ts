/*-
 *
 * Hedera JSON RPC Relay
 *
 * Copyright (C) 2022-2024 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import app from './server';
import { ConfigService } from '@hashgraph/json-rpc-config-service/dist/services';
import { setServerTimeout } from './koaJsonRpc/lib/utils'; // Import the 'setServerTimeout' function from the correct location

async function main() {
  const server = app.listen({ port: ConfigService.get('SERVER_PORT') || 7546, host: ConfigService.get('SERVER_HOST') });

  // set request timeout to ensure sockets are closed after specified time of inactivity
  setServerTimeout(server);
}

main();
