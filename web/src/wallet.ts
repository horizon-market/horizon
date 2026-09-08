import { createWalletClient, createPublicClient, custom, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';

type Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?: (event: string, handler: (...args: unknown[]) => void) => void };
const SEPOLIA_HEX = '0xaa36a7';

export class WalletError extends Error {}

function provider(): Provider {
  const injected = (window as unknown as { ethereum?: Provider }).ethereum;
  if (!injected) throw new WalletError('No Ethereum wallet was detected in this browser. Install one to sign Sepolia transactions.');
  return injected;
}

export function walletAvailable(): boolean {
  return Boolean((window as unknown as { ethereum?: Provider }).ethereum);
}

export async function connect(): Promise<Address> {
  const accounts = await provider().request({ method: 'eth_requestAccounts' }) as Address[];
  const account = accounts[0];
  if (!account) throw new WalletError('The wallet returned no account.');
  return account;
}

export async function currentAccount(): Promise<Address | undefined> {
  if (!walletAvailable()) return undefined;
  const accounts = await provider().request({ method: 'eth_accounts' }) as Address[];
  return accounts[0];
}

/** Horizon trading is Sepolia only; signing on another chain would target the wrong contracts. */
export async function ensureSepolia(): Promise<void> {
  const chainId = await provider().request({ method: 'eth_chainId' }) as string;
  if (chainId === SEPOLIA_HEX) return;
  try { await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA_HEX }] }); }
  catch { throw new WalletError('Switch the wallet to Ethereum Sepolia and try again.'); }
}

const clients = (account: Address) => ({
  wallet: createWalletClient({ account, chain: sepolia, transport: custom(provider()) }),
  reader: createPublicClient({ chain: sepolia, transport: custom(provider()) }),
});

export type PreparedTransaction = { to: string; data: string; value: string };

export async function send(account: string, transaction: PreparedTransaction): Promise<Hex> {
  await ensureSepolia();
  const { wallet } = clients(account as Address);
  return wallet.sendTransaction({ to: transaction.to as Address, data: transaction.data as Hex, value: BigInt(transaction.value) });
}

export async function approve(account: string, token: string, spender: string, amount: string): Promise<Hex> {
  return send(account, { to: token, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Address, BigInt(amount)] }) });
}

export async function confirm(account: string, hash: string): Promise<'success' | 'reverted'> {
  const { reader } = clients(account as Address);
  const receipt = await reader.waitForTransactionReceipt({ hash: hash as Hex, timeout: 180_000 });
  return receipt.status;
}

export function describeWalletError(error: unknown): string {
  if (error instanceof WalletError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/User rejected|denied transaction/i.test(message)) return 'The wallet request was rejected.';
  if (/insufficient funds/i.test(message)) return 'The account does not have enough Sepolia ETH for gas.';
  return message.split('\n')[0] ?? 'The wallet request failed.';
}
