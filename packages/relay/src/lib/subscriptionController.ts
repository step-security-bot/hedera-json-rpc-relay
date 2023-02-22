/*-
 *
 * Hedera JSON RPC Relay
 *
 * Copyright (C) 2023 Hedera Hashgraph, LLC
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

import { Poller } from './poller';
import { Logger } from 'pino';
import LRU from "lru-cache";
import constants from "./constants";
import crypto from "crypto";

export interface Subscriber {
    connection: any,
    subscriptionId: string
}

const LOGGER_PREFIX = 'Subscriptions:';

export class SubscriptionController {
    private poller: Poller;
    private logger: Logger;
    private subscriptions: {[key: string]: Subscriber[]};
    private cache;

    constructor(poller: Poller, logger: Logger) {
        this.poller = poller;
        this.logger = logger;
        this.subscriptions = {};
        this.cache = new LRU({ max: constants.CACHE_MAX, ttl: 2000 });
    }

    // Generates a random 16 byte hex string
    generateId() {
        let id = '0x';
        for (let i = 0; i < 3; i++) {
            id += Math.floor(Math.random() * 10000000000).toString(16).padStart(8, '0').slice(-8);
        }
        id += Date.now().toString(16).slice(-8);
        return id;
    }

    subscribe(connection, event: string, filters?: {}) {

        let tag: any = {event};
        if (filters && Object.keys(filters).length) {
            tag.filters = filters;
        }

        tag = JSON.stringify(tag);

        if (!this.subscriptions[tag]) {
            this.subscriptions[tag] = [];
        }

        const subId = this.generateId();

        this.logger.info(`${LOGGER_PREFIX} New subscription ${subId}, listening for ${tag}`);

        this.subscriptions[tag].push({
            subscriptionId: subId,
            connection
        });

        this.poller.add(tag, this.notifySubscribers.bind(this, tag));
        return subId;
    }

    unsubscribe(connection, subId?: string) {
        const {id} = connection;

        if (subId) {
            this.logger.info(`${LOGGER_PREFIX} Unsubscribing connection ${id} from subscription ${subId}`);
        }
        else {
            this.logger.info(`${LOGGER_PREFIX} Unsubscribing all instances of connection ${id}`);
        }

        for (const [tag, subs] of Object.entries(this.subscriptions)) {
            this.subscriptions[tag] = subs.filter(sub => {
                const match = sub.connection.id === id && (!subId || subId === sub.subscriptionId);
                if (match) {
                    this.logger.info(`${LOGGER_PREFIX} Unsubscribing ${sub.subscriptionId}, from ${tag}`);
                }

                return !match;
            });

            if (!this.subscriptions[tag].length) {
                this.logger.info(`${LOGGER_PREFIX} No subscribers for ${tag}`);
                delete this.subscriptions[tag];
                this.poller.remove(tag);
            }
        }

        return true;
    }

    notifySubscribers(tag, data) {
        if (this.subscriptions[tag] && this.subscriptions[tag].length) {
            this.subscriptions[tag].forEach(sub => {
                const subscriptionData = {
                    result: data,
                    subscription: sub.subscriptionId
                };
                const hash = crypto.createHash('sha1').update(JSON.stringify(subscriptionData)).digest('hex');

                // If the hash exists in the cache then the data has recently been sent to the subscriber
                if (!this.cache.get(hash)) {
                    this.cache.set(hash, true);
                    this.logger.info(`${LOGGER_PREFIX} Sending new data from ${tag} to subscriptionId ${sub.subscriptionId}, connectionId ${sub.connection.id}`);
                    sub.connection.send(JSON.stringify({
                        method: 'eth_subscription',
                        params: subscriptionData
                    }));
                }
            })
        }
    }
}
