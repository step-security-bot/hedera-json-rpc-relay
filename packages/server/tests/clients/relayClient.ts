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

import { BlockTag, ethers } from 'ethers';
import { Logger } from 'pino';
import Assertions from '../helpers/assertions';
import { predefined } from '@hashgraph/json-rpc-relay/dist/lib/errors/JsonRpcError';
import { Utils } from '../helpers/utils';

export default class RelayClient {
  readonly provider: ethers.JsonRpcProvider;
  private readonly logger: Logger;

  constructor(relayUrl: string, logger: Logger) {
    this.logger = logger;
    let fr: ethers.FetchRequest = new ethers.FetchRequest(relayUrl);
    this.provider = new ethers.JsonRpcProvider(fr);
  }

  /**
   * Calls the specified methodName with the provided params
   * @param methodName
   * @param params
   * @param requestId
   */
  async call(methodName: string, params: any[], requestId?: string) {
    const requestIdPrefix = Utils.formatRequestIdMessage(requestId);
    const result = await this.provider.send(methodName, params);
    this.logger.trace(
      `${requestIdPrefix} [POST] to relay '${methodName}' with params [${JSON.stringify(
        params,
      )}] returned ${JSON.stringify(result)}`,
    );
    return result;
  }

  /**
   * Sends a batch request.
   *
   * The `payload` is an array of JSON-RPC requests.
   * The `method` and `params` fields correspond to the arguments of the `call` method.
   *
   * @param payload
   * @returns
   */
  async callBatch(payload: { id: number; method: string; params: any[] }[]) {
    const request = this.provider._getConnection();
    request.setHeader('content-type', 'application/json');
    request.body = JSON.stringify(payload.map((r) => ({ ...r, jsonrpc: '2.0' })));
    const response = await request.send();
    response.assertOk();

    return response.bodyJson;
  }

  /**
   * Calls the specified methodName with the provided params and asserts that it fails
   * @param methodName
   * @param params
   * @param expectedRpcError
   * @param requestId
   */
  async callFailing(
    methodName: string,
    params: any[],
    expectedRpcError = predefined.INTERNAL_ERROR(),
    requestId?: string,
  ) {
    const requestIdPrefix = Utils.formatRequestIdMessage(requestId);
    try {
      const res = await this.call(methodName, params, requestId);
      this.logger.trace(
        `${requestIdPrefix} [POST] to relay '${methodName}' with params [${params}] returned ${JSON.stringify(res)}`,
      );
      Assertions.expectedError();
    } catch (e: any) {
      if (expectedRpcError.message.includes('execution reverted')) {
        if (e?.info) {
          Assertions.jsonRpcError(e.info.error, expectedRpcError);
        } else if (e?.error) {
          Assertions.jsonRpcError(e.error, expectedRpcError);
        } else {
          Assertions.expectedError();
        }
      } else {
        Assertions.jsonRpcError(e?.response?.bodyJson?.error, expectedRpcError);
      }
    }
  }

  /**
   * Calls the specified methodName and asserts that it is not supported
   * @param methodName
   * @param params
   * @param requestId
   */
  async callUnsupported(methodName: string, params: any[], requestId?: string) {
    try {
      await this.call(methodName, params, requestId);
      Assertions.expectedError();
    } catch (e: any) {
      Assertions.unsupportedResponse(e?.response?.bodyJson);
    }
  }

  /**
   * Gets the account balance by executing `eth_getBalance`
   * @param address
   * @param block
   * @param requestId
   */
  async getBalance(address: ethers.AddressLike, block: BlockTag = 'latest', requestId?: string) {
    const requestIdPrefix = Utils.formatRequestIdMessage(requestId);
    this.logger.debug(`${requestIdPrefix} [POST] to relay eth_getBalance for address ${address}]`);
    return this.provider.getBalance(address, block);
  }

  /**
   * @param evmAddress
   * @param requestId
   * Returns: The nonce of the account with the provided `evmAddress`
   */
  async getAccountNonce(evmAddress: string, requestId?: string): Promise<number> {
    const requestIdPrefix = Utils.formatRequestIdMessage(requestId);
    this.logger.debug(`${requestIdPrefix} [POST] to relay for eth_getTransactionCount for address ${evmAddress}`);
    const nonce = await this.provider.send('eth_getTransactionCount', [evmAddress, 'latest']);
    return Number(nonce);
  }

  /**
   * This invokes the relay logic from eth.ts/sendRawTransaction.
   *
   * Returns: Transaction hash
   * @param signedTx
   * @param requestId
   */
  async sendRawTransaction(signedTx, requestId?: string): Promise<string> {
    const requestIdPrefix = Utils.formatRequestIdMessage(requestId);
    this.logger.debug(`${requestIdPrefix} [POST] to relay for eth_sendRawTransaction`);
    return this.provider.send('eth_sendRawTransaction', [signedTx]);
  }

  /**
   * @param requestId
   *
   * Returns the result of eth_gasPrice as a Number.
   */
  async gasPrice(requestId?: string): Promise<number> {
    return Number(await this.call('eth_gasPrice', [], requestId));
  }
}
