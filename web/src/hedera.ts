import { DAppConnector, HederaChainId, HederaJsonRpcMethod, HederaSessionEvent } from '@hashgraph/hedera-wallet-connect';
import { AccountId, Hbar, LedgerId, TokenId, TransactionId, TransferTransaction } from '@hiero-ledger/sdk';
import { ExactHederaScheme } from '@x402/hedera';
import type { PaymentRequirements as CorePaymentRequirements, PaymentPayload } from '@x402/core/types';
import type { PaymentRequirements, PaymentResource } from './api';

let connector: DAppConnector | undefined;
let initializedFor: string | undefined;

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

async function getConnector(projectId: string) {
  if (connector && initializedFor === projectId) return connector;
  connector = new DAppConnector(
    { name: 'Horizon', description: 'Prediction markets with zero trading fees', url: window.location.origin, icons: [] },
    LedgerId.TESTNET,
    projectId,
    Object.values(HederaJsonRpcMethod),
    [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
    [HederaChainId.Testnet],
  );
  await connector.init({ logger: 'error' });
  initializedFor = projectId;
  return connector;
}

/** Connects a Hedera wallet and asks it to sign the facilitator-co-signed x402 transfer. */
export async function createHederaPaymentSignature(projectId: string, resource: PaymentResource, requirements: PaymentRequirements) {
  if (requirements.network !== 'hedera:testnet') throw new Error('Only Hedera testnet payments are supported in this release.');
  const feePayer = requirements.extra.feePayer;
  if (!feePayer) throw new Error('The facilitator did not advertise its Hedera fee payer.');
  const dapp = await getConnector(projectId);
  if (dapp.signers.length === 0) await dapp.openModal(undefined, true);
  const wallet = dapp.signers[0];
  if (!wallet) throw new Error('The Hedera wallet returned no testnet account.');
  const accountId = wallet.getAccountId();
  const clientSigner = {
    accountId: accountId.toString(),
    createPartiallySignedTransferTransaction: async (selected: CorePaymentRequirements) => {
      const amount = BigInt(selected.amount);
      if (amount <= 0n) throw new Error('The payment amount must be positive.');
      const transaction = new TransferTransaction();
      if (selected.asset === '0.0.0') {
        transaction.addHbarTransfer(accountId, Hbar.fromTinybars((-amount).toString()));
        transaction.addHbarTransfer(AccountId.fromString(selected.payTo), Hbar.fromTinybars(amount.toString()));
      } else {
        const token = TokenId.fromString(selected.asset);
        transaction.addTokenTransfer(token, accountId, -amount);
        transaction.addTokenTransfer(token, AccountId.fromString(selected.payTo), amount);
      }
      transaction.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));
      const signed = await wallet.signTransaction(transaction);
      return base64(signed.toBytes());
    },
  };
  const partial = await new ExactHederaScheme(clientSigner).createPaymentPayload(2, requirements as CorePaymentRequirements);
  const payload: PaymentPayload = { ...partial, resource, accepted: requirements as CorePaymentRequirements };
  return { accountId: accountId.toString(), signature: btoa(JSON.stringify(payload)) };
}
