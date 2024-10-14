/*-
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

import fs from 'fs';
import { expect } from 'chai';
import { resolve } from 'path';
import { Logger } from 'pino';
import dotenv, { config } from 'dotenv';
import { BaseContract, ethers } from 'ethers';
import { predefined } from '@hashgraph/json-rpc-relay';

// Local resources
import { Utils } from '../helpers/utils';
import Assertions from '../helpers/assertions';
import testConstants from '../helpers/constants';
import RelayClient from '../clients/relayClient';
import MirrorClient from '../clients/mirrorClient';
import MetricsClient from '../clients/metricsClient';
import { AliasAccount } from '../types/AliasAccount';
import { RequestDetails } from '@hashgraph/json-rpc-relay/dist/lib/types';
import { estimateFileTransactionsFee, overrideEnvsInMochaDescribe } from '@hashgraph/json-rpc-relay/tests/helpers';
import constants from '@hashgraph/json-rpc-relay/dist/lib/constants';

// Contracts used in tests
import parentContractJson from '../contracts/Parent.json';
import { SubscriptionTier } from '@hashgraph/json-rpc-relay/dist/lib/db/types/hbarLimiter/subscriptionTier';
import EstimateGasContract from '../contracts/EstimateGasContract.json';
import largeContractJson from '../contracts/hbarLimiterContracts/largeSizeContract.json';
import mediumSizeContract from '../contracts/hbarLimiterContracts/mediumSizeContract.json';
import { ITransfer } from '@hashgraph/json-rpc-relay/dist/lib/types';
import { Registry } from 'prom-client';
import { CacheService } from '@hashgraph/json-rpc-relay/dist/lib/services/cacheService/cacheService';
import { HbarSpendingPlanRepository } from '@hashgraph/json-rpc-relay/dist/lib/db/repositories/hbarLimiter/hbarSpendingPlanRepository';
import { EthAddressHbarSpendingPlanRepository } from '@hashgraph/json-rpc-relay/dist/lib/db/repositories/hbarLimiter/ethAddressHbarSpendingPlanRepository';
import { IPAddressHbarSpendingPlanRepository } from '@hashgraph/json-rpc-relay/dist/lib/db/repositories/hbarLimiter/ipAddressHbarSpendingPlanRepository';
import { HbarLimitService } from '@hashgraph/json-rpc-relay/dist/lib/services/hbarLimitService';

config({ path: resolve(__dirname, '../localAcceptance.env') });
const DOT_ENV = dotenv.parse(fs.readFileSync(resolve(__dirname, '../localAcceptance.env')));
let hbarSpendingPlanRepository: HbarSpendingPlanRepository;
let ethAddressSpendingPlanRepository: EthAddressHbarSpendingPlanRepository;
let ipSpendingPlanRepository: IPAddressHbarSpendingPlanRepository;

describe('@hbarlimiter HBAR Limiter Acceptance Tests', function () {
  // @ts-ignore
  const {
    mirrorNode,
    relay,
    logger,
    initialBalance,
    metrics,
    relayIsLocal,
  }: {
    mirrorNode: MirrorClient;
    relay: RelayClient;
    logger: Logger;
    initialBalance: string;
    metrics: MetricsClient;
    relayIsLocal: boolean;
  } = global;
  const operatorAccount = process.env.OPERATOR_ID_MAIN || DOT_ENV.OPERATOR_ID_MAIN || '';
  const fileAppendChunkSize = Number(process.env.FILE_APPEND_CHUNK_SIZE) || 5120;
  const requestId = 'hbarLimiterTest';
  const requestDetails = new RequestDetails({ requestId: requestId, ipAddress: '0.0.0.0' });
  const registry = new Registry();
  const cacheService = new CacheService(logger, registry);

  // The following tests exhaust the hbar limit, so they should only be run against a local relay
  if (relayIsLocal) {
    const deployContract = async (contractJson: any, wallet: ethers.Wallet): Promise<ethers.Contract> => {
      const contract = await Utils.deployContract(contractJson.abi, contractJson.bytecode, wallet);
      expect(contract).to.be.instanceOf(BaseContract);
      await contract.waitForDeployment();
      expect(contract.target).to.not.be.null;
      return contract;
    };

    const verifyRemainingLimit = (expectedCost: number, remainingHbarsBefore: number, remainingHbarsAfter: number) => {
      const delta = 0.02 * expectedCost;
      global.logger.debug(`Expected cost: ${expectedCost} ±${delta}`);
      global.logger.debug(`Actual cost: ${remainingHbarsBefore - remainingHbarsAfter}`);
      global.logger.debug(`Actual delta: ${(remainingHbarsBefore - remainingHbarsAfter) / (expectedCost * 100)}`);
      expect(remainingHbarsAfter).to.be.approximately(remainingHbarsBefore - expectedCost, delta);
    };

    const sumAccountTransfers = (transfers: ITransfer[], account?: string) => {
      return Math.abs(
        transfers
          .filter((transfer) => transfer.account === account)
          .reduce((acc, transfer) => acc + transfer.amount, 0),
      );
    };

    const getExpectedCostOfFileCreateTx = async () => {
      const fileCreateTx = (
        await mirrorNode.get(
          `/transactions?transactiontype=FILECREATE&order=desc&account.id=${operatorAccount}&limit=1`,
          requestId,
        )
      ).transactions[0];

      const fileCreateTxFee = sumAccountTransfers(fileCreateTx.transfers, operatorAccount);
      const fileCreateTimestamp = fileCreateTx.consensus_timestamp;
      return { fileCreateTxFee, fileCreateTimestamp };
    };

    const getExpectedCostOfFileAppendTx = async (timeStamp: string, txData: string) => {
      const fileAppendTxs = (
        await mirrorNode.get(
          `/transactions?order=desc&transactiontype=FILEAPPEND&account.id=${operatorAccount}&timestamp=gt:${timeStamp}`,
          requestId,
        )
      ).transactions;
      const fileAppendTxFee = fileAppendTxs.reduce((total: number, data: { transfers: ITransfer[] }) => {
        const sum = sumAccountTransfers(data.transfers, operatorAccount);
        return total + sum;
      }, 0);

      // The first chunk goes in with FileCreateTransaciton, the rest are FileAppendTransactions
      const expectedChunks = Math.ceil(txData.length / fileAppendChunkSize) - 1;
      expect(fileAppendTxs.length).to.eq(expectedChunks);

      return fileAppendTxFee;
    };

    const getExpectedCostOfLastLargeTx = async (txData: string) => {
      const ethereumTransaction = (
        await mirrorNode.get(
          `/transactions?transactiontype=ETHEREUMTRANSACTION&order=desc&account.id=${operatorAccount}&limit=1`,
          requestId,
        )
      ).transactions[0];
      const ethereumTxFee = sumAccountTransfers(ethereumTransaction.transfers, operatorAccount);
      const { fileCreateTxFee, fileCreateTimestamp } = await getExpectedCostOfFileCreateTx();
      const fileAppendTxFee = await getExpectedCostOfFileAppendTx(fileCreateTimestamp, txData);

      const fileDeleteTx = (
        await mirrorNode.get(
          `/transactions?transactiontype=FILEDELETE&order=desc&account.id=${operatorAccount}&limit=1`,
          requestId,
        )
      ).transactions[0];

      const fileDeleteTxFee = fileDeleteTx ? sumAccountTransfers(fileDeleteTx.transfers, operatorAccount) : 0;

      return ethereumTxFee + fileCreateTxFee + fileAppendTxFee + fileDeleteTxFee;
    };

    const getExpectedCostOfLastSmallTx = async (requestId: string) => {
      const ethereumTransaction = (
        await mirrorNode.get(
          `/transactions?transactiontype=ETHEREUMTRANSACTION&order=desc&account.id=${operatorAccount}&limit=1`,
          requestId,
        )
      ).transactions[0];
      return sumAccountTransfers(ethereumTransaction.transfers, operatorAccount);
    };

    const getResetTimestamp = (): Date => {
      const todayAtMidnight = new Date().setHours(0, 0, 0, 0);
      let resetDate = new Date(todayAtMidnight);
      while (resetDate.getTime() < Date.now()) {
        // 1. Calculate the difference between the current time and the reset time.
        // 2. Determine how many intervals of size `limitDuration` have passed since the last reset.
        // 3. Calculate the new reset date by adding the required intervals to the original reset date.
        const intervalsPassed = Math.ceil((Date.now() - resetDate.getTime()) / constants.HBAR_RATE_LIMIT_DURATION);
        resetDate = new Date(resetDate.getTime() + intervalsPassed * constants.HBAR_RATE_LIMIT_DURATION);
      }
      return resetDate;
    };

    describe('HBAR Rate Limit Tests', function () {
      overrideEnvsInMochaDescribe({ GET_RECORD_DEFAULT_TO_CONSENSUS_NODE: 'true' });
      this.timeout(480 * 1000); // 480 seconds

      const accounts: AliasAccount[] = [];
      const defaultLondonTransactionData = {
        value: Utils.add0xPrefix(Utils.toHex(ethers.parseUnits('1', 10))), // 1 tinybar
        chainId: Number(process.env.CHAIN_ID || 0),
        maxPriorityFeePerGas: Assertions.defaultGasPrice,
        maxFeePerGas: Assertions.defaultGasPrice,
        gasLimit: 3_000_000,
        type: 2,
      };

      before(async function () {
        // Restart the relay to reset the limits
        //await global.restartLocalRelay();
        await cacheService.clear(requestDetails);
        hbarSpendingPlanRepository = new HbarSpendingPlanRepository(cacheService, logger);
        ethAddressSpendingPlanRepository = new EthAddressHbarSpendingPlanRepository(cacheService, logger);
        ipSpendingPlanRepository = new IPAddressHbarSpendingPlanRepository(cacheService, logger);

        logger.info(`${requestDetails.formattedRequestId} Creating accounts`);
        logger.info(
          `${requestDetails.formattedRequestId} HBAR_RATE_LIMIT_TINYBAR: ${process.env.HBAR_RATE_LIMIT_TINYBAR}`,
        );

        const initialAccount: AliasAccount = global.accounts[0];

        const neededAccounts: number = 4;
        accounts.push(
          ...(await Utils.createMultipleAliasAccounts(
            mirrorNode,
            initialAccount,
            neededAccounts,
            initialBalance,
            requestDetails,
          )),
        );
        global.accounts.push(...accounts);
      });

      beforeEach(async function () {
        await ipSpendingPlanRepository.deleteAll(requestDetails);
      });

      describe('Total HBAR Limit', () => {
        before(async () => {
          logger.info(`${requestDetails.formattedRequestId} Waiting until the next reset of the HBAR rate limiter`);
          const nextReset = getResetTimestamp();
          await new Promise((r) => setTimeout(r, nextReset.getTime() - Date.now()));
        });

        it('should execute "eth_sendRawTransaction" for BASIC user without triggering HBAR rate limit exceeded', async function () {
          const parentContract = await deployContract(parentContractJson, accounts[0].wallet);
          const parentContractAddress = parentContract.target as string;
          global.logger.trace(
            `${requestDetails.formattedRequestId} Deploy parent contract on address ${parentContractAddress}`,
          );

          const gasPrice = await relay.gasPrice(requestId);
          const remainingHbarsBefore = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));

          const transaction = {
            ...defaultLondonTransactionData,
            to: parentContractAddress,
            nonce: await relay.getAccountNonce(accounts[1].address, requestId),
            maxPriorityFeePerGas: gasPrice,
            maxFeePerGas: gasPrice,
          };
          const signedTx = await accounts[1].wallet.signTransaction(transaction);

          await expect(relay.call(testConstants.ETH_ENDPOINTS.ETH_SEND_RAW_TRANSACTION, [signedTx], requestId)).to.be
            .fulfilled;

          const remainingHbarsAfter = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          const expectedCost = await getExpectedCostOfLastSmallTx(requestId);

          verifyRemainingLimit(expectedCost, remainingHbarsBefore, remainingHbarsAfter);
        });

        it('should deploy a large contract and decrease remaining HBAR in limiter when transaction data is large', async function () {
          const remainingHbarsBefore = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          expect(remainingHbarsBefore).to.be.gt(0);

          const contract = await deployContract(largeContractJson, accounts[0].wallet);

          const remainingHbarsAfter = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          const expectedCost = await getExpectedCostOfLastLargeTx(contract.deploymentTransaction()!.data);

          verifyRemainingLimit(expectedCost, remainingHbarsBefore, remainingHbarsAfter);
        });

        it('should be able to deploy a contract without creating file', async function () {
          const remainingHbarsBefore = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          expect(remainingHbarsBefore).to.be.gt(0);

          // This flow should not spend any hbars from the operator, as it's fully paid by the signer
          await deployContract(EstimateGasContract, accounts[0].wallet);

          const remainingHbarsAfter = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          const expectedCost = await getExpectedCostOfLastSmallTx(requestId);
          verifyRemainingLimit(expectedCost, remainingHbarsBefore, remainingHbarsAfter);
        });

        it('should be able to deploy a medium size contract with fileCreate', async function () {
          const remainingHbarsBefore = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          expect(remainingHbarsBefore).to.be.gt(0);

          // This flow should spend hbars from the operator, for fileCreate
          const contract = await deployContract(mediumSizeContract, accounts[1].wallet);

          const remainingHbarsAfter = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          const expectedCost = await getExpectedCostOfLastLargeTx(contract.deploymentTransaction()!.data);
          verifyRemainingLimit(expectedCost, remainingHbarsBefore, remainingHbarsAfter);
        });

        it('should verify the estimated and actual transaction fees for file transactions are approximately equal', async function () {
          const contract = await deployContract(mediumSizeContract, accounts[1].wallet);
          let exchangeRateResult = (await mirrorNode.get(`/network/exchangerate`, requestId)).current_rate;
          const exchangeRateInCents = exchangeRateResult.cent_equivalent / exchangeRateResult.hbar_equivalent;

          const { fileCreateTxFee, fileCreateTimestamp } = await getExpectedCostOfFileCreateTx();
          const fileAppendTxFee = await getExpectedCostOfFileAppendTx(
            fileCreateTimestamp,
            contract.deploymentTransaction()!.data,
          );

          const fileChunkSize = Number(process.env.FILE_APPEND_CHUNK_SIZE) || 5120;
          const estimatedTxFee = estimateFileTransactionsFee(
            contract.deploymentTransaction()!.data.length,
            fileChunkSize,
            exchangeRateInCents,
          );

          const estimatedFileTransactionTotalFee = estimatedTxFee;
          const actualFileTransactionTotalFee = fileCreateTxFee + fileAppendTxFee;

          const tolerance = 0.003 * actualFileTransactionTotalFee; // 0.3% tolerance
          expect(estimatedFileTransactionTotalFee).to.be.approximately(actualFileTransactionTotalFee, tolerance);
        });
      });

      describe('Tiered HBAR Rate Limit', () => {
        before(async () => {
          //Unlink all ip addresses from plans since the current tests are ran on localhost and the ip address is the same
          await ipSpendingPlanRepository.deleteAll(requestDetails);

          // Wait until the next reset of the HBAR rate limiter
          logger.info(`${requestDetails.formattedRequestId} Waiting until the next reset of the HBAR rate limiter`);
          const nextReset = getResetTimestamp();
          await new Promise((r) => setTimeout(r, nextReset.getTime() - Date.now()));
        });

        it('HBAR limiter is updated within acceptable tolerance range in relation to actual spent amount by the relay operator', async function () {
          const TOLERANCE = 0.02;
          const remainingHbarsBefore = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          expect(remainingHbarsBefore).to.be.gt(0);
          const operatorBalanceBefore = (await mirrorNode.get(`/accounts/${operatorAccount}`, requestId)).balance
            .balance;
          const largeContract = await deployContract(largeContractJson, accounts[0].wallet);

          const operatorBalanceAfter = (await mirrorNode.get(`/accounts/${operatorAccount}`, requestId)).balance
            .balance;

          const amountPaidByOperator = operatorBalanceBefore - operatorBalanceAfter;

          const totalOperatorFees = await getExpectedCostOfLastLargeTx(largeContract.deploymentTransaction()!.data);
          const remainingHbarsAfter = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          const hbarLimitReducedAmount = remainingHbarsBefore - remainingHbarsAfter;

          expect(remainingHbarsAfter).to.be.lt(remainingHbarsBefore);
          Assertions.expectWithinTolerance(amountPaidByOperator, hbarLimitReducedAmount, TOLERANCE);
          Assertions.expectWithinTolerance(amountPaidByOperator, totalOperatorFees, TOLERANCE);
        });

        it('should create a BASIC spending plan for a new user and use the same plan on second transaction', async function () {
          const parentContract = await deployContract(parentContractJson, accounts[0].wallet);
          const parentContractAddress = parentContract.target as string;
          global.logger.trace(
            `${requestDetails.formattedRequestId} Deploy parent contract on address ${parentContractAddress}`,
          );

          //Unlinking the ipAdress, since ipAddress when running tests in CI and locally is the same
          await ipSpendingPlanRepository.deleteAll(requestDetails);
          expect(ethAddressSpendingPlanRepository.findByAddress(accounts[3].address, requestDetails)).to.be.rejected;
          const gasPrice = await relay.gasPrice(requestId);
          const transaction = {
            ...defaultLondonTransactionData,
            to: parentContractAddress,
            nonce: await relay.getAccountNonce(accounts[3].address, requestId),
            maxPriorityFeePerGas: gasPrice,
            maxFeePerGas: gasPrice,
          };
          const signedTx = await accounts[3].wallet.signTransaction(transaction);

          await expect(relay.call(testConstants.ETH_ENDPOINTS.ETH_SEND_RAW_TRANSACTION, [signedTx], requestId)).to.be
            .fulfilled;

          const ethSpendingPlan = await ethAddressSpendingPlanRepository.findByAddress(
            accounts[3].address,
            requestDetails,
          );
          expect(ethSpendingPlan).to.not.be.undefined;

          const spendingPlanAssociated = await hbarSpendingPlanRepository.findByIdWithDetails(
            ethSpendingPlan.planId,
            requestDetails,
          );
          const amountSpendAfterFirst = spendingPlanAssociated.amountSpent;

          const secondTransaction = {
            ...defaultLondonTransactionData,
            to: parentContractAddress,
            nonce: await relay.getAccountNonce(accounts[3].address, requestId),
            maxPriorityFeePerGas: gasPrice,
            maxFeePerGas: gasPrice,
          };
          const signedTxSecond = await accounts[3].wallet.signTransaction(secondTransaction);

          await expect(relay.call(testConstants.ETH_ENDPOINTS.ETH_SEND_RAW_TRANSACTION, [signedTxSecond], requestId)).to
            .be.fulfilled;

          const spendingPlanAssociatedAfterSecond = await hbarSpendingPlanRepository.findByIdWithDetails(
            ethSpendingPlan.planId,
            requestDetails,
          );
          expect(amountSpendAfterFirst).to.be.lt(spendingPlanAssociatedAfterSecond.amountSpent);
        });

        it('should eventually exhaust the hbar limit for a BASIC user after multiple deployments of large contracts', async function () {
          const fileChunkSize = Number(process.env.FILE_APPEND_CHUNK_SIZE) || 5120;
          const exchangeRateResult = (await mirrorNode.get(`/network/exchangerate`, requestId)).current_rate;
          const exchangeRateInCents = exchangeRateResult.cent_equivalent / exchangeRateResult.hbar_equivalent;

          const factory = new ethers.ContractFactory(
            largeContractJson.abi,
            largeContractJson.bytecode,
            accounts[0].wallet,
          );
          const deployedTransaction = await factory.getDeployTransaction();
          const estimatedTxFee = estimateFileTransactionsFee(
            deployedTransaction.data.length,
            fileChunkSize,
            exchangeRateInCents,
          );

          //Unlinking the ipAdress, since ipAddress when running tests in CI and locally is the same
          await ipSpendingPlanRepository.deleteAll(requestDetails);
          expect(ethAddressSpendingPlanRepository.findByAddress(accounts[2].address, requestDetails)).to.be.rejected;
          try {
            for (let i = 0; i < 50; i++) {
              await deployContract(largeContractJson, accounts[2].wallet);
            }
            expect.fail(`Expected an error but nothing was thrown`);
          } catch (e: any) {
            expect(e.message).to.contain(predefined.HBAR_RATE_LIMIT_EXCEEDED.message);

            const ethSpendingPlan = await ethAddressSpendingPlanRepository.findByAddress(
              accounts[2].wallet.address,
              requestDetails,
            );

            const spendingPlanAssociated = await hbarSpendingPlanRepository.findByIdWithDetails(
              ethSpendingPlan.planId,
              requestDetails,
            );
            const basicSpendingLimit = HbarLimitService.TIER_LIMITS[SubscriptionTier.BASIC];
            const amountSpent = spendingPlanAssociated.amountSpent;

            // Explanation: A preemptive rate limit check triggers the HBAR_RATE_LIMIT_EXCEED error when basicSpendingLimit < estimatedTxFee + amountSpent.
            expect(basicSpendingLimit.toTinybars().toNumber()).to.be.lt(estimatedTxFee + amountSpent);
          }
        });

        //this test is skipped since its currently just gonna test for BASIC user, may be reworked for privileged/extended user
        it.skip('multiple deployments of large contracts should eventually exhaust the remaining hbar limit', async function () {
          const remainingHbarsBefore = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
          const fileChunkSize = Number(process.env.FILE_APPEND_CHUNK_SIZE) || 5120;
          let exchangeRateResult = (await mirrorNode.get(`/network/exchangerate`, requestId)).current_rate;
          const exchangeRateInCents = exchangeRateResult.cent_equivalent / exchangeRateResult.hbar_equivalent;

          const factory = new ethers.ContractFactory(
            largeContractJson.abi,
            largeContractJson.bytecode,
            accounts[0].wallet,
          );
          const deployedTransaction = await factory.getDeployTransaction();
          const estimatedTxFee = estimateFileTransactionsFee(
            deployedTransaction.data.length,
            fileChunkSize,
            exchangeRateInCents,
          );

          let lastRemainingHbars = remainingHbarsBefore;
          expect(remainingHbarsBefore).to.be.gt(0);
          try {
            for (let i = 0; i < 50; i++) {
              const contract = await deployContract(largeContractJson, accounts[0].wallet);
              await contract.waitForDeployment();
              const remainingHbars = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));
              expect(remainingHbars).to.be.lt(lastRemainingHbars);
            }
            expect.fail(`Expected an error but nothing was thrown`);
          } catch (e: any) {
            expect(e.message).to.contain(predefined.HBAR_RATE_LIMIT_EXCEEDED.message);
          }

          const remainingHbarsAfter = Number(await metrics.get(testConstants.METRICS.REMAINING_HBAR_LIMIT));

          // Explanation: A preemptive rate limit check triggers the HBAR_RATE_LIMIT_EXCEED error when (remainingBudget - estimatedTxFee) < 0.
          //             In this scenario, the final remainingHbarsAfter is expected to be less than estimatedTxFee.
          expect(remainingHbarsAfter).to.be.lt(estimatedTxFee);
        });
      });
    });
  }
});
