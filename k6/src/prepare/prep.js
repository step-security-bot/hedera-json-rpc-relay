import Greeter from './contracts/Greeter.json' assert { type: 'json' };
import { ethers } from 'ethers';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logPayloads = process.env.DEBUG_MODE === 'true';

class LoggingProvider extends ethers.JsonRpcProvider {
  async send(method, params) {
    if (logPayloads) {
      const request = {
        method: method,
        params: params,
        id: this._nextId++,
        jsonrpc: '2.0',
      };

      console.log('>>>', method, '-->', JSON.stringify(request));
    }

    const result = await super.send(method, params);
    if (logPayloads) {
      console.log('<<<', method, '-->', result);
    }
    return result;
  }
}

function randomIntFromInterval(min, max) {
  // min and max included
  return Math.floor(Math.random() * (max - min + 1) + min);
}

async function getSignedTxs(wallet, greeterContracts, gasPrice, gasLimit, chainId) {
  const amount = process.env.SIGNED_TXS ? process.env.SIGNED_TXS : 5;
  console.log(`Generating (${amount}) Txs for Performance Test...`);
  let nonce = 0; // since all wallets are new and have no transactions, no need to get nonce from the network
  const signedTxCollection = [];
  for (let i = 0; i < amount; i++) {
    const greeterContractAddress = randomIntFromInterval(0, greeterContracts.length - 1);
    const greeterContract = new ethers.Contract(greeterContracts[greeterContractAddress], Greeter.abi, wallet);
    const msg = `Greetings from Automated Test Number ${i}, Hello!`;
    const trx = await greeterContract.setGreeting.populateTransaction(msg);
    trx.gasLimit = gasLimit;
    trx.chainId = chainId;
    trx.gasPrice = gasPrice;
    trx.nonce = nonce + i;
    const signedTx = await wallet.signTransaction(trx);
    signedTxCollection.push(signedTx);
    console.log('Transaction ' + i + ' signed.');
  }

  return signedTxCollection;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RELAY_BASE_URL);
  const mainPrivateKeyString = process.env.PRIVATE_KEY;
  const mainWallet = new ethers.Wallet(mainPrivateKeyString, new LoggingProvider(process.env.RELAY_BASE_URL));
  console.log('RPC Server:  ' + process.env.RELAY_BASE_URL);
  console.log('Main Wallet Address: ' + mainWallet.address);
  console.log(
    'Main Wallet Initial Balance: ' + ethers.formatEther(await provider.getBalance(mainWallet.address)) + ' HBAR',
  );
  const usersCount = process.env.WALLETS_AMOUNT ? process.env.WALLETS_AMOUNT : 1;
  const contractsCount = process.env.SMART_CONTRACTS_AMOUNT ? process.env.SMART_CONTRACTS_AMOUNT : 1;
  const smartContracts = [];
  for (let i = 0; i < contractsCount; i++) {
    const contractFactory = new ethers.ContractFactory(Greeter.abi, Greeter.bytecode, mainWallet);
    console.log(`Deploying Greeter SC  ${i}`);
    const contract = await contractFactory.deploy('Hey World!');
    const contractAddress = contract.target;
    console.log(`Greeter SC Address: ${contractAddress}`);
    smartContracts.push(contractAddress);
  }

  const wallets = [];

  const chainId = (await provider.getNetwork()).chainId;

  const msgForEstimate = `Greetings from Automated Test Number i, Hello!`;
  const contractForEstimate = new ethers.Contract(smartContracts[0], Greeter.abi, mainWallet);
  const gasLimit = ethers.toQuantity(
    Math.round(Number(await contractForEstimate.setGreeting.estimateGas(msgForEstimate)) * 1.5),
  ); // extra
  const gasPrice = ethers.toQuantity(Math.round(Number((await provider.getFeeData()).gasPrice) * 1.5)); // with extra

  for (let i = 0; i < usersCount; i++) {
    const wallet = ethers.Wallet.createRandom();

    console.log('Wallet ' + i + ' created.');
    console.log('privateKey: ', wallet.privateKey);
    console.log('address: ', wallet.address);

    // amount to send (HBAR)
    let amountInEther = '10';
    // Create transaction
    let tx = {
      to: wallet.address,
      // Convert currency unit from ether to wei
      value: ethers.parseEther(amountInEther),
    };

    // Send transaction
    await mainWallet.sendTransaction(tx).then((txObj) => {
      console.log('txHash', txObj.hash);
    });

    const balance = await provider.getBalance(wallet.address);
    console.log('balance: ', ethers.formatEther(balance));

    const walletProvider = new ethers.Wallet(wallet.privateKey, new LoggingProvider(process.env.RELAY_BASE_URL));
    const signedTxCollection = await getSignedTxs(walletProvider, smartContracts, gasPrice, gasLimit, chainId);

    let walletData = {};
    walletData['index'] = i;
    walletData['address'] = wallet.address;
    walletData['privateKey'] = wallet.privateKey;
    walletData['latestBalance'] = ethers.formatEther(balance);
    walletData['latestNonce'] = await walletProvider.getNonce();
    walletData['signedTxs'] = signedTxCollection;
    wallets.push(walletData);
  }
  const latestBlock = await provider.getBlockNumber();
  console.log('Latest Block: ' + latestBlock);

  console.log('Creating smartContractParams.json file...');

  const output = {};
  output['mainWalletAddress'] = mainWallet.address;
  output['latestBlock'] = latestBlock;
  output['contractAddress'] = smartContracts[0];
  output['contractsAddresses'] = smartContracts;
  output['wallets'] = wallets;

  fs.writeFileSync(path.resolve(__dirname) + '/.smartContractParams.json', JSON.stringify(output, null, 2));
})();
