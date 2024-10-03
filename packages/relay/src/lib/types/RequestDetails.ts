/*
 *
 * Hedera JSON RPC Relay
 *
 * Copyright (C) 2024 Hedera Hashgraph, LLC
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

/**
 * Interface representing the details of a request.
 */
export interface IRequestDetails {
  /**
   * The unique identifier for the request.
   * @type {string}
   */
  requestId: string;

  /**
   * The IP address from which the request originated.
   * @type {string}
   */
  ipAddress: string;

  /**
   * The connection ID associated with the request (optional).
   * @type {string | undefined}
   */
  connectionId?: string;
}

/**
 * Represents the details of a request.
 */
export class RequestDetails {
  /**
   * The unique identifier for the request.
   */
  requestId: string;

  /**
   * The IP address from which the request originated.
   */
  ipAddress: string;

  /**
   * The connection ID associated with the request (optional).
   */
  connectionId?: string;

  /**
   * Creates an instance of RequestDetails.
   * @param {IRequestDetails} details - The details of the request.
   */
  constructor(details: IRequestDetails) {
    this.requestId = details.requestId;
    this.ipAddress = details.ipAddress;
    this.connectionId = details.connectionId;
  }

  /**
   * Gets the formatted request ID.
   * @returns {string} The formatted request ID, or an empty string if requestId is not set.
   */
  get formattedRequestId(): string {
    return this.requestId ? `[Request ID: ${this.requestId}]` : '';
  }

  /**
   * Gets the formatted connection ID.
   * @returns {string | undefined} The formatted connection ID, or an empty string if connectionId is not set.
   */
  get formattedConnectionId(): string | undefined {
    return this.connectionId ? `[Connection ID: ${this.connectionId}]` : '';
  }

  /**
   * Gets the formatted log prefix.
   * @returns {string} The formatted log prefix, combining connection ID and request ID if both are set.
   */
  get formattedLogPrefix(): string {
    const connectionId = this.formattedConnectionId;
    const requestId = this.formattedRequestId;
    if (connectionId && requestId) {
      return `${connectionId} ${requestId}`;
    }
    return connectionId || requestId;
  }
}