'use strict'
const ARTIFACTS = require('@0x/contract-artifacts');
const _ = require('lodash');
const cw3p = require('create-web3-provider');
const ethjs = require('ethereumjs-util');
const fs = require('mz/fs');
const readline = require('readline');
const Web3 = require('web3');
const abiCoder = require('web3-eth-abi');
const yargs = require('yargs');

const ARGV = yargs.string('output').boolean('pretty').argv;
const INPUT_FILE = ARGV._[0];
const OUTPUT_FILE = ARGV.output;
const EXCHANGE_ABI = ARTIFACTS.Exchange.compilerOutput.abi;
const BLOCK_CACHE = {};
const SELECTOR_TO_ABI = extractMethodAbis();
const CODE_TO_ORDER_STATUS = [
    'INVALID',
    'INVALID_MAKER_ASSET_AMOUNT',
    'INVALID_TAKER_ASSET_AMOUNT',
    'FILLABLE',
    'EXPIRED',
    'FULLY_FILLED',
    'CANCELLED'
];

(async function() {
    const web3 = new Web3(cw3p({infuraKey: '05aa59b27d614baa90c6d86d9b0c6ab5'}));
    const transactions = {};
    let counter = 0;
    const lines = readline.createInterface({
        input: fs.createReadStream(INPUT_FILE),
    });
    lines.on('line', async (line) => {
        const trace = JSON.parse(line);
        const orders = await evaluateCallOrders(web3, trace);
        if (orders.length > 0) {
            transactions[trace.transactionHash] = mergeTransactionResults(
                transactions[trace.transactionHash],
                {
                    transactionHash: trace.transactionHash,
                    blockNumber: trace.blockNumber,
                    orders: orders,
                    success: trace.status === 1,
                },
            );
        }
        counter++;
    });
    lines.on('close', async () => {
        await writeResults(transactions);
        summarizeResults(transactions);
        console.log(`processed ${counter} traces, ${_.keys(transactions).length} transactions`);
    });
})();


async function writeResults(transactions) {
    const txs = _.sortBy(
        _.values(
            _.mapValues(
                transactions,
                (tx, hash) => _.assign({transactionHash: hash}, tx)
            )
        ),
        tx => -tx.blockNumber,
    );
    const json = JSON.stringify(txs, null, '  ');
    if (OUTPUT_FILE) {
        await fs.writeFile(OUTPUT_FILE, json, 'utf-8');
    } else {
        console.log(json);
    }
}

function summarizeResults(transactions) {
    const ordersByStatus = _.zipObject(
        CODE_TO_ORDER_STATUS,
        _.times(CODE_TO_ORDER_STATUS.length, () => [])
    );
    const orders = [];
    let totalSuccessfulTransactions = 0;
    let totalFailedTransactions = 0;
    for (const transactionHash in transactions) {
        const tx = transactions[transactionHash];
        for (const order of tx.orders) {
            ordersByStatus[order.status].push(order);
            orders.push(order);
        }
        if (tx.success) {
            totalSuccessfulTransactions++;
        } else {
            totalFailedTransactions++;
        }
    }
    const totalUniqueOrders = _.uniqBy(orders, o => o.hash).length;
    const totalOrders = orders.length;
    const orderCountsByStatus = _.mapValues(ordersByStatus, os => os.length);
    const expiredTTLs = ordersByStatus['EXPIRED'].map(o => o.timeToLive).sort((a, b) => a - b);
    const allTTLs = _.flatten(_.values(ordersByStatus)).map(o => o.timeToLive).sort((a, b) => a - b);
    const fillableTTLs = ordersByStatus['FILLABLE'].map(o => o.timeToLive).sort((a, b) => a - b);
    console.log({
        totalOrders,
        totalUniqueOrders,
        orderCountsByStatus,
        totalSuccessfulTransactions,
        totalFailedTransactions,
        totalTransactions: _.keys(transactions).length,
        medianTTL: allTTLs[Math.floor(allTTLs.length / 2)],
        medianFillableTTL: fillableTTLs[Math.floor(fillableTTLs.length / 2)],
        medianExpiredTTL: expiredTTLs[Math.floor(expiredTTLs.length / 2)]
    });
}

function extractMethodAbis() {
    const results = {};
    for (const abi of EXCHANGE_ABI) {
        if (abi.type === 'function') {
            results[abiCoder.encodeFunctionSignature(abi)] = abi;
        }
    }
    return results;
}

async function evaluateCallOrders(web3, trace) {
    const _evaluateOrder = async (order) => evaluateOrder(web3, trace, order);
    const selector = sliceBytes(trace.callData, 0, 4);
    const abi = SELECTOR_TO_ABI[selector];
    if (abi === undefined) {
        throw new Error(`Unknown function selector: ${selector}`);
    }
    const encodedParameters = sliceBytes(trace.callData, 4);
    const args = abiCoder.decodeParameters(abi.inputs, encodedParameters);
    if (args.order) {
        return [ await _evaluateOrder(args.order) ];
    } else if (args.orders) {
        return await Promise.all(args.orders.map(_evaluateOrder));
    } else {
        console.info(`Not processing call to ${abi.name}.`);
    }
}

async function evaluateOrder(web3, trace, order) {
    const contract = new web3.eth.Contract(EXCHANGE_ABI, trace.calleeAddress);
    const orderInfo = await contract.methods.getOrderInfo(order).call(
        {from: trace.calleeAddress},
        trace.blockNumber,
    );
    const block = trace.blockNumber in BLOCK_CACHE ?
        BLOCK_CACHE[trace.blockNumber] : await web3.eth.getBlock(trace.blockNumber);
    return {
        timeToLive: order.expirationTimeSeconds - block.timestamp,
        hash: orderInfo.orderHash,
        status: CODE_TO_ORDER_STATUS[orderInfo.orderStatus],
        takerAssetFilledAmount: orderInfo.orderTakerAssetFilledAmount.toString(10),
        order: {
            makerAddress: order.makerAddress,
            takerAddress: order.makerAddress,
            feeRecipientAddress: order.feeRecipientAddress,
            senderAddress: order.senderAddress,
            makerAssetAmount: order.makerAssetAmount.toString(10),
            takerAssetAmount: order.takerAssetAmount.toString(10),
            makerFee: order.makerFee.toString(10),
            takerFee: order.takerFee.toString(10),
            expirationTimeSeconds: order.expirationTimeSeconds.toString(10),
            salt: order.salt.toString(10),
            makerAsetData: order.makerAsetData,
            takerAsetData: order.takerAsetData,
        },
    };
}

function sliceBytes(bytes, from, to) {
    return ethjs.bufferToHex(ethjs.toBuffer(bytes).slice(from, to));
}

function mergeTransactionResults(current, result) {
    const merged = current || {};
    merged.transactionHash = result.transactionHash;
    merged.blockNumber = result.blockNumber;
    merged.success = result.success;
    merged.orders = merged.orders || [];
    merged.orders = [...merged.orders, ...result.orders];
    return merged;
}
