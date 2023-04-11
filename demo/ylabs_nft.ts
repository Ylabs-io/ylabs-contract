import {Connection, Ed25519Keypair, JsonRpcProvider, RawSigner} from '@mysten/sui.js';
import * as fs from 'fs';
require('dotenv').config()

const connection = new Connection({
  fullnode: process.env.SUI_RPC_URL!,
  faucet: process.env.FAUCET_URL,
});
let provider = new JsonRpcProvider(connection);
const adminKey = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.ADMIN_KEY_PAIR_SEED!, 'hex')));
const admin = new RawSigner( adminKey, provider );
const merchantKey = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.MERCHANT_KEY_PAIR_SEED!, 'hex')));
const merchant = new RawSigner( merchantKey, provider );
const userKey = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.USER_KEY_PAIR_SEED!, 'hex')));
const user = new RawSigner( userKey, provider );

const YLABS_NFT_IMAGE_URL_INITIAL = 'https://';
const YLABS_NFT_IMAGE_URL_REDEEMED = 'https://';

const gasBudget = 100000;

interface PublishResult {
  moduleId: string,
  globalObjectId: string,
}

async function publish(): Promise<PublishResult> {
  const compiledModules = [fs.readFileSync('packages/momentx/build/MomentX/bytecode_modules/ylabs_nft.mv', {encoding: 'base64'})];
  const publishTxn = await admin.publish({
    compiledModules,
    gasBudget,
  });
  console.log('publishTxn', JSON.stringify(publishTxn, null, 2));
  const newObjectEvent = (publishTxn as any).effects.effects.events.filter((e: any) => e.newObject !== undefined)[0].newObject;
  console.log('newObjectEvent', JSON.stringify(newObjectEvent, null, 2));
  const moduleId = newObjectEvent.packageId;
  const globalObjectId = newObjectEvent.objectId;
  return { moduleId, globalObjectId }
}

async function interact_with_contract(params: PublishResult) {
  const { moduleId, globalObjectId } = params;
  // set urls
  const setUrlTxn = await admin.executeMoveCall({
    packageObjectId: moduleId,
    module: 'ylabs_nft',
    function: 'set_urls',
    typeArguments: [],
    arguments: [
      globalObjectId,
      YLABS_NFT_IMAGE_URL_INITIAL,
      YLABS_NFT_IMAGE_URL_REDEEMED,
    ],
    gasBudget,
  });
  console.log('setUrlTxn', JSON.stringify(setUrlTxn));
  // add merchant
  const addMerchantTxn = await admin.executeMoveCall({
    packageObjectId: moduleId,
    module: 'ylabs_nft',
    function: 'add_merchant',
    typeArguments: [],
    arguments: [
      globalObjectId,
      '0x' + await merchant.getAddress(),
    ],
    gasBudget,
  });
  console.log('addMerchantTxn', JSON.stringify(addMerchantTxn));
  // set stock
  const setStockTxn = await merchant.executeMoveCall({
    packageObjectId: moduleId,
    module: 'ylabs_nft',
    function: 'set_stock',
    typeArguments: [],
    arguments: [
      globalObjectId,
      "100",
    ],
    gasBudget,
  });
  console.log('setStockTxn', JSON.stringify(setStockTxn));
  // airdrop
  const airdropTxn = await admin.executeMoveCall({
    packageObjectId: moduleId,
    module: 'ylabs_nft',
    function: 'airdrop',
    typeArguments: [],
    arguments: [
      globalObjectId,
      '0x' + await user.getAddress(),
      'ylabs',
      'ylabs NFT',
    ],
    gasBudget,
  });
  console.log('airdropTxn', JSON.stringify(airdropTxn, null, 2));
  const nftObjectId = (airdropTxn as any).effects.effects.events.filter((e: any) => e.newObject?.objectType === `${moduleId}::ylabs_nft::YlabsNFT`)[0].newObject.objectId;

  const redeemRequestTxn = await merchant.executeMoveCall({
    packageObjectId: moduleId,
    module: 'ylabs_nft',
    function: 'redeem_request',
    typeArguments: [],
    arguments: [
      globalObjectId,
      nftObjectId,
    ],
    gasBudget,
  });
  console.log('redeemRequestTxn', JSON.stringify(redeemRequestTxn));
  // redeem confirm
  const redeemConfirmTxn = await user.executeMoveCall({
    packageObjectId: moduleId,
    module: 'ylabs_nft',
    function: 'redeem_confirm',
    typeArguments: [],
    arguments: [
      globalObjectId,
      nftObjectId,
      '0x' + await merchant.getAddress(),
    ],
    gasBudget,
  });
  console.log('redeemConfirmTxn', JSON.stringify(redeemConfirmTxn));
}

async function queries(moduleId: string, globalConfigId: string) {
  const globalObject = await provider.getObject(globalConfigId);
  console.log('globalObject', JSON.stringify(globalObject, null, 2));
  // list all merchants
  const merchants = (globalObject.details as any).data.fields.merchants.fields.contents;
  console.log('merchants', JSON.stringify(merchants, null, 2));
  // list all ylabs NFTs
  const ylabsTableId = (globalObject.details as any).data.fields.nfts.fields.id.id;
  let cursor = null;
  const hexRegex = /(0x[a-fA-F\d]{40})/;
  while (true) {
    const yalbsNFTs: any = await provider.getDynamicFields(ylabsTableId, cursor);
    console.log('ylabsNFTs', JSON.stringify(yalbsNFTs, null, 2));
    for (const nft of yalbsNFTs.data) {
      console.log(nft.name);
      const objectId = nft.name.match(hexRegex)[1];
      const nftObject = await provider.getObject(objectId);
      console.log('nftObject', JSON.stringify(nftObject, null, 2));
    }
    if (yalbsNFTs.nextCursor === null) {
      break;
    } else {
      cursor = yalbsNFTs.nextCursor;
    }
  }
  // get ylabs NFT by user address
  const userAddr = '0x' + await user.getAddress();
  const userObjects = await provider.getObjectsOwnedByAddress(userAddr);
  const ylabsNFTsByUser = userObjects.filter(o => o.type === `${moduleId}::ylabs_nft::YlabsNFT`)
  console.log('ylabsNFTsByUser', JSON.stringify(ylabsNFTsByUser, null, 2));
}

async function main() {
  console.log('-----start-----');
  const adminAddr = await admin.getAddress();
  console.log(`admin address: 0x${adminAddr}`);
  const merchantAddr = await merchant.getAddress();
  console.log(`merchant address: 0x${merchantAddr}`);
  const userAddr = await user.getAddress();
  console.log(`user address: 0x${userAddr}`)
  if (connection.faucet) {
    const res = await provider.requestSuiFromFaucet(adminAddr);
    console.log('requestSuiFromFaucet', JSON.stringify(res, null, 2));
    const res2 = await provider.requestSuiFromFaucet(merchantAddr);
    console.log('requestSuiFromFaucet', JSON.stringify(res2, null, 2));
    const res3 = await provider.requestSuiFromFaucet(userAddr);
    console.log('requestSuiFromFaucet', JSON.stringify(res3, null, 2));
  }

  const publishResult = await publish();
  console.log(`PublishResult: ${JSON.stringify(publishResult, null, 2)}`);
  await interact_with_contract(publishResult);
  const { moduleId, globalObjectId } = publishResult;
  await queries(moduleId, globalObjectId);
  console.log('-----end-----');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`error: ${error.stack}`);
    process.exit(1);
  });
