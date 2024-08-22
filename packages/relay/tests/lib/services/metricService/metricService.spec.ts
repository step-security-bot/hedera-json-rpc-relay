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

import pino from 'pino';
import { expect } from 'chai';
import { resolve } from 'path';
import * as sinon from 'sinon';
import { config } from 'dotenv';
import { Registry } from 'prom-client';
import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { Utils } from '../../../../src/utils';
import constants from '../../../../src/lib/constants';
import HbarLimit from '../../../../src/lib/hbarlimiter';
import { MirrorNodeClient, SDKClient } from '../../../../src/lib/clients';
import { calculateTxRecordChargeAmount, getRequestId } from '../../../helpers';
import MetricService from '../../../../src/lib/services/metricService/metricService';
import { CacheService } from '../../../../src/lib/services/cacheService/cacheService';
import { Hbar, Long, Status, Client, AccountId, TransactionRecord, TransactionRecordQuery } from '@hashgraph/sdk';

config({ path: resolve(__dirname, '../../../test.env') });
const registry = new Registry();
const logger = pino();

describe('Metric Service', function () {
  let client: Client;
  let mock: MockAdapter;
  let hbarLimiter: HbarLimit;
  let instance: AxiosInstance;
  let metricService: MetricService;
  let mirrorNodeClient: MirrorNodeClient;

  const mockedTxFee = 36900000;
  const operatorAcocuntId = `0.0.1022`;
  const mockedCallerName = 'caller_name';
  const mockedExecutionType = 'exection_type';
  const mockedConstructorName = 'constructor_name';
  const mockedTransactionType = 'transaction_type';
  const mockedInteractingEntity = 'interacting_entity';
  const mockedTransactionId = '0.0.1022@1681130064.409933500';
  const mockedTransactionIdFormatted = '0.0.1022-1681130064-409933500';
  const metricHistogramCostSumTitle = 'rpc_relay_consensusnode_response_sum';
  const metricHistogramGasFeeSumTitle = 'rpc_relay_consensusnode_gasfee_sum';
  const mockedMirrorNodeTransactionRecord = {
    transactions: [
      {
        charged_tx_fee: mockedTxFee,
        result: 'SUCCESS',
        transaction_id: '0.0.1022-1681130064-409933500',
        transfers: [
          {
            account: operatorAcocuntId,
            amount: -1 * mockedTxFee,
            is_approval: false,
          },
        ],
      },
    ],
  };

  const mockedConsensusNodeTransactionRecord = {
    receipt: {
      status: Status.Success,
      exchangeRate: { exchangeRateInCents: 12 },
    },
    transactionFee: new Hbar(mockedTxFee),
    contractFunctionResult: {
      gasUsed: new Long(0, 1000, true),
    },
    transfers: [
      {
        accountId: operatorAcocuntId,
        amount: Hbar.fromTinybars(-1 * mockedTxFee),
        is_approval: false,
      },
    ],
  } as unknown as TransactionRecord;

  before(() => {
    process.env.OPERATOR_KEY_FORMAT = 'DER';

    // consensus node client
    const hederaNetwork = process.env.HEDERA_NETWORK!;
    if (hederaNetwork in constants.CHAIN_IDS) {
      client = Client.forName(hederaNetwork);
    } else {
      client = Client.forNetwork(JSON.parse(hederaNetwork));
    }
    client = client.setOperator(
      AccountId.fromString(process.env.OPERATOR_ID_MAIN!),
      Utils.createPrivateKeyBasedOnFormat(process.env.OPERATOR_KEY_MAIN!),
    );

    // mirror node client
    instance = axios.create({
      baseURL: 'https://localhost:5551/api/v1',
      responseType: 'json' as const,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 20 * 1000,
    });
    mirrorNodeClient = new MirrorNodeClient(
      process.env.MIRROR_NODE_URL || '',
      logger.child({ name: `mirror-node` }),
      registry,
      new CacheService(logger.child({ name: `cache` }), registry),
      instance,
    );
  });

  beforeEach(() => {
    mock = new MockAdapter(instance);

    const duration = constants.HBAR_RATE_LIMIT_DURATION;
    const total = constants.HBAR_RATE_LIMIT_TINYBAR;

    hbarLimiter = new HbarLimit(logger.child({ name: 'hbar-rate-limit' }), Date.now(), total, duration, registry);

    const sdkClient = new SDKClient(
      client,
      logger.child({ name: `consensus-node` }),
      hbarLimiter,
      new CacheService(logger.child({ name: `cache` }), registry),
    );
    // Init new MetricService instance
    metricService = new MetricService(logger, sdkClient, mirrorNodeClient, hbarLimiter, registry);
  });

  afterEach(() => {
    sinon.restore();
    mock.restore();
  });

  describe('captureTransactionMetrics', () => {
    it('Should execute captureTransactionMetrics() by retrieving transaction record from MIRROR NODE client', async () => {
      mock.onGet(`transactions/${mockedTransactionIdFormatted}?nonce=0`).reply(200, mockedMirrorNodeTransactionRecord);

      process.env.GET_RECORD_DEFAULT_TO_CONSENSUS_NODE = 'false';

      const originalBudget = hbarLimiter.getRemainingBudget();

      // capture metrics
      await metricService.captureTransactionMetrics(
        mockedTransactionId,
        mockedCallerName,
        getRequestId(),
        mockedConstructorName,
        operatorAcocuntId,
        mockedTransactionType,
        mockedInteractingEntity,
      );

      // validate hbarLimiter
      const updatedBudget = hbarLimiter.getRemainingBudget();
      expect(originalBudget - updatedBudget).to.eq(mockedTxFee);

      // validate cost metrics
      const costMetricObject = (await metricService.getCostMetric().get()).values.find(
        (metric) => metric.metricName === metricHistogramCostSumTitle,
      )!;
      expect(costMetricObject.metricName).to.eq(metricHistogramCostSumTitle);
      expect(costMetricObject.labels.caller).to.eq(mockedCallerName);
      expect(costMetricObject.labels.type).to.eq(mockedTransactionType);
      expect(costMetricObject.labels.interactingEntity).to.eq(mockedInteractingEntity);
      expect(costMetricObject.value).to.eq(mockedTxFee);
    });

    it('Should execute captureTransactionMetrics() by retrieving transaction record from CONSENSUS NODE client', async () => {
      process.env.GET_RECORD_DEFAULT_TO_CONSENSUS_NODE = 'true';
      const mockedExchangeRateInCents = 12;
      const expectedTxRecordFee = calculateTxRecordChargeAmount(mockedExchangeRateInCents);

      const transactionRecordStub = sinon
        .stub(TransactionRecordQuery.prototype, 'execute')
        .resolves(mockedConsensusNodeTransactionRecord);

      const originalBudget = hbarLimiter.getRemainingBudget();

      await metricService.captureTransactionMetrics(
        mockedTransactionId,
        mockedCallerName,
        getRequestId(),
        mockedConstructorName,
        operatorAcocuntId,
        mockedTransactionType,
        mockedInteractingEntity,
      );
      expect(transactionRecordStub.called).to.be.true;

      // validate hbarLimiter
      // note: since the query is made to consensus node, the total charged amount = txFee + txRecordFee
      const updatedBudget = hbarLimiter.getRemainingBudget();
      expect(originalBudget - updatedBudget).to.eq(mockedTxFee + expectedTxRecordFee);

      // validate cost metrics
      const costMetricObject = (await metricService.getCostMetric().get()).values.find(
        (metric) => metric.metricName === metricHistogramCostSumTitle,
      )!;
      expect(costMetricObject.metricName).to.eq(metricHistogramCostSumTitle);
      expect(costMetricObject.labels.caller).to.eq(mockedCallerName);
      expect(costMetricObject.labels.type).to.eq(mockedTransactionType);
      expect(costMetricObject.labels.interactingEntity).to.eq(mockedInteractingEntity);
      expect(costMetricObject.value).to.eq(mockedTxFee + expectedTxRecordFee);

      // validate gas metric
      const gasMetricObject = (await metricService.getGasFeeMetric().get()).values.find(
        (metric) => metric.metricName === metricHistogramGasFeeSumTitle,
      )!;

      expect(gasMetricObject.metricName).to.eq(metricHistogramGasFeeSumTitle);
      expect(gasMetricObject.labels.caller).to.eq(mockedCallerName);
      expect(gasMetricObject.labels.type).to.eq(mockedTransactionType);
      expect(gasMetricObject.labels.interactingEntity).to.eq(mockedInteractingEntity);
      expect(gasMetricObject.value).to.eq(
        mockedConsensusNodeTransactionRecord.contractFunctionResult?.gasUsed.toNumber(),
      );
    });
  });

  describe('addExpenseAndCaptureMetrics', () => {
    it('should execute addExpenseAndCaptureMetrics() to capture metrics in HBAR limiter and metric registry', async () => {
      const mockedGasUsed = mockedConsensusNodeTransactionRecord.contractFunctionResult!.gasUsed.toNumber();
      const originalBudget = hbarLimiter.getRemainingBudget();

      // capture metrics
      metricService.addExpenseAndCaptureMetrics(
        mockedExecutionType,
        mockedTransactionId,
        mockedTransactionType,
        mockedCallerName,
        mockedTxFee,
        mockedGasUsed,
        mockedInteractingEntity,
        getRequestId(),
      );

      // validate hbarLimiter
      const updatedBudget = hbarLimiter.getRemainingBudget();
      expect(originalBudget - updatedBudget).to.eq(mockedTxFee);

      // validate cost metrics
      const costMetricObject = (await metricService.getCostMetric().get()).values.find(
        (metric) => metric.metricName === metricHistogramCostSumTitle,
      )!;
      expect(costMetricObject.metricName).to.eq(metricHistogramCostSumTitle);
      expect(costMetricObject.labels.caller).to.eq(mockedCallerName);
      expect(costMetricObject.labels.type).to.eq(mockedTransactionType);
      expect(costMetricObject.labels.interactingEntity).to.eq(mockedInteractingEntity);
      expect(costMetricObject.value).to.eq(mockedTxFee);

      // validate gas metric
      const gasMetricObject = (await metricService.getGasFeeMetric().get()).values.find(
        (metric) => metric.metricName === metricHistogramGasFeeSumTitle,
      )!;

      expect(gasMetricObject.metricName).to.eq(metricHistogramGasFeeSumTitle);
      expect(gasMetricObject.labels.caller).to.eq(mockedCallerName);
      expect(gasMetricObject.labels.type).to.eq(mockedTransactionType);
      expect(gasMetricObject.labels.interactingEntity).to.eq(mockedInteractingEntity);
      expect(gasMetricObject.value).to.eq(
        mockedConsensusNodeTransactionRecord.contractFunctionResult?.gasUsed.toNumber(),
      );
    });
  });
});
