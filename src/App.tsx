// App.tsx — Vault dApp (Ethereum Sepolia)
// - Connect with RainbowKit (WalletConnect)
// - Auto-target Ethereum Sepolia
// - Reads ERC-4626 vault (ObexBTCVault) + its policy helpers
// - Detects paused state, caps, min/max, cooldowns
// - Approve -> Deposit (assets)
// - Redeem (shares)
//
// Fill in: VAULT_ADDRESS and WALLETCONNECT_PROJECT_ID
//
// npm i wagmi@2 viem@2 @rainbow-me/rainbowkit@2 zustand
// (Tailwind optional; this will render fine without it.)

import React, { useMemo, useState } from 'react'
import { http, useAccount, useReadContract, useWriteContract, useSwitchChain, WagmiProvider } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { formatUnits, parseUnits } from 'viem'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'
import { RainbowKitProvider, getDefaultConfig, ConnectButton } from '@rainbow-me/rainbowkit'

/*****************************
 * 1) ENV / CONSTANTS
 *****************************/
// 1) Read from env (Vite style). Fall back to current values for local dev.
const WALLETCONNECT_PROJECT_ID =
  import.meta?.env?.VITE_WALLETCONNECT_PROJECT_ID || 'd0a8af4a7604d9cd340ddc6fb5d2b8fa';

const VAULT_ADDRESS =
  (import.meta?.env?.VITE_VAULT_ADDRESS as `0x${string}`) || '0xbfB71eD001E504C782cC60F4D2bb744854e19eD5';


/*****************************
 * 2) ABIs (minimal, safe)
 *****************************/
// Minimal ERC20 (decimals/symbol/balance/allowance/approve)
const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

// ERC-4626 + ObexBTCVault view helpers you shared
const VAULT_ABI = [
  // ERC-20 meta
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },

  // ERC-4626 core views
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToShares', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewDeposit', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewRedeem', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxRedeem', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },

  // ERC-4626 actions
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name:'assets', type: 'uint256' }, { name:'receiver', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [{ name:'shares', type: 'uint256' }, { name:'receiver', type: 'address' }, { name:'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },

  // ObexBTCVault policy/status helpers
  { type: 'function', name: 'isPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'availableToDeposit', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'depositCap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'minDepositTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxDepositTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'minWithdrawTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxWithdrawTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'depositCooldown', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'withdrawCooldown', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'offchainAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'lastDepositAt', stateMutability: 'view', inputs: [{ type:'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'lastWithdrawAt', stateMutability: 'view', inputs: [{ type:'address' }], outputs: [{ type: 'uint256' }] },
] as const

/*****************************
 * 3) Wagmi/Rainbow config (Sepolia)
 *****************************/
const config = getDefaultConfig({
  appName: 'Vault dApp – Sepolia',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [sepolia],
  transports: { [sepolia.id]: http() },
  ssr: false,
})

const qc = new QueryClient()

/*****************************
 * 4) Utility formatters
 *****************************/
function fmt(n?: bigint | undefined, decimals = 18, fallback = '-') {
  if (n === undefined) return fallback
  try { return Number(formatUnits(n, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) } catch { return String(n) }
}

/*****************************
 * 5) Main screen
 *****************************/
function Screen() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  // Force user to be on Sepolia
  const wrongChain = isConnected && chainId !== sepolia.id

  // Vault core reads
  const { data: vaultName } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'name' })
  const { data: vaultSymbol } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'symbol' })
  const { data: vaultDecimals } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'decimals' })
  const vDec = Number(vaultDecimals ?? 18)

  const { data: assetAddress } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'asset' })

  const { data: totalAssets } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'totalAssets' })
  const { data: totalSupply } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'totalSupply' })

  // Policy reads
  const { data: paused } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'isPaused' })
  const { data: availableToDeposit } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'availableToDeposit' })
  const { data: depositCap } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'depositCap' })
  const { data: minDep } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'minDepositTx' })
  const { data: maxDep } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'maxDepositTx' })
  const { data: minWdr } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'minWithdrawTx' })
  const { data: maxWdr } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'maxWithdrawTx' })
  const { data: depCd } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'depositCooldown' })
  const { data: wdrCd } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'withdrawCooldown' })
  const { data: offchain } = useReadContract({ abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'offchainAssets' })

  // Asset token reads (only when we have assetAddress)
  const { data: tokenSymbol } = useReadContract({
    abi: ERC20_ABI, address: assetAddress as `0x${string}` | undefined, functionName: 'symbol', query: { enabled: Boolean(assetAddress) },
  })
  const { data: tokenDecimals } = useReadContract({
    abi: ERC20_ABI, address: assetAddress as `0x${string}` | undefined, functionName: 'decimals', query: { enabled: Boolean(assetAddress) },
  })
  const aDec = Number(tokenDecimals ?? 6)

  const { data: walletAssetBal } = useReadContract({
    abi: ERC20_ABI, address: assetAddress as `0x${string}` | undefined, functionName: 'balanceOf',
    args: address ? [address] : undefined, query: { enabled: Boolean(assetAddress && address) },
  })

  const { data: userShares } = useReadContract({
    abi: ERC20_ABI, address: VAULT_ADDRESS, functionName: 'balanceOf', args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  // UI state
  const [depInput, setDepInput] = useState('')
  const [redInput, setRedInput] = useState('')

  // Previews
  const depAmount = useMemo(() => {
    try { return parseUnits(depInput || '0', aDec) } catch { return 0n }
  }, [depInput, aDec])

  const redShares = useMemo(() => {
    try { return parseUnits(redInput || '0', vDec) } catch { return 0n }
  }, [redInput, vDec])

  const { data: previewShares } = useReadContract({
    abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'previewDeposit', args: [depAmount],
    query: { enabled: depAmount > 0n },
  })

  const { data: previewAssets } = useReadContract({
    abi: VAULT_ABI, address: VAULT_ADDRESS, functionName: 'previewRedeem', args: [redShares],
    query: { enabled: redShares > 0n },
  })

  // Allowance
  const { data: allowance } = useReadContract({
    abi: ERC20_ABI, address: assetAddress as `0x${string}` | undefined, functionName: 'allowance',
    args: address ? [address, VAULT_ADDRESS] : undefined,
    query: { enabled: Boolean(assetAddress && address) },
  })

  // Write hooks
  const { writeContractAsync, isPending: isWriting } = useWriteContract()

  // Client-side validation helpers
  const belowMinDep = minDep && depAmount > 0n && depAmount < minDep
  const aboveMaxDep = maxDep && depAmount > 0n && depAmount > maxDep
  const overAvailDep = availableToDeposit && depAmount > availableToDeposit

  const aboveMaxWdr = maxWdr && redShares > 0n && previewAssets !== undefined && previewAssets > maxWdr
  const belowMinWdr = minWdr && redShares > 0n && previewAssets !== undefined && previewAssets < minWdr

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Interact with Your Vault</h1>
            <p className="text-sm opacity-70">Network: Ethereum Sepolia (11155111)</p>
          </div>
          <ConnectButton />
        </header>

        {wrongChain && (
          <div className="rounded-xl p-4 bg-amber-100 border border-amber-300">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">Wrong network</p>
                <p className="text-sm opacity-75">Please switch to Ethereum Sepolia to continue.</p>
              </div>
              <button
                className="px-3 py-2 rounded-lg bg-amber-600 text-white hover:opacity-90"
                onClick={() => switchChainAsync?.({ chainId: sepolia.id })}
              >Switch</button>
            </div>
          </div>
        )}

        {paused && (
          <div className="rounded-xl p-4 bg-red-100 border border-red-300">
            <p className="font-medium">Vault is paused</p>
            <p className="text-sm opacity-75">Deposits and withdrawals are disabled by the owner/guardian.</p>
          </div>
        )}

        {/* Info cards */}
        <section className="grid sm:grid-cols-2 gap-4">
          <Card title="Vault">
            <Row label="Name" value={String(vaultName ?? '—')} />
            <Row label="Symbol" value={String(vaultSymbol ?? '—')} />
            <Row label="Total Assets" value={`${fmt(totalAssets, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Total Supply" value={fmt(totalSupply, vDec)} />
            <Row label="Off-chain Assets" value={`${fmt(offchain, aDec)} ${tokenSymbol ?? ''}`} />
          </Card>
          <Card title="Asset">
            <Row label="Token" value={String(tokenSymbol ?? '—')} />
            <Row label="Decimals" value={String(aDec)} />
            <Row label="Your Asset Bal" value={`${fmt(walletAssetBal, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Your Shares" value={fmt(userShares, vDec)} />
          </Card>
        </section>

        {/* Policy panel */}
        <Card title="Policy & Limits">
          <div className="grid sm:grid-cols-2 gap-2">
            <Row label="Deposit Cap" value={`${fmt(depositCap, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Available to Deposit" value={`${fmt(availableToDeposit, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Min Deposit" value={`${fmt(minDep, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Max Deposit" value={`${fmt(maxDep, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Min Withdraw" value={`${fmt(minWdr, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Max Withdraw" value={`${fmt(maxWdr, aDec)} ${tokenSymbol ?? ''}`} />
            <Row label="Deposit Cooldown" value={`${depCd ?? 0n} s`} />
            <Row label="Withdraw Cooldown" value={`${wdrCd ?? 0n} s`} />
          </div>
        </Card>

        {/* Deposit */}
        <Card title="Deposit (assets → shares)">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-sm mb-1">Amount ({tokenSymbol ?? 'asset'})</label>
              <input
                value={depInput}
                onChange={(e) => setDepInput(e.target.value)}
                placeholder="0.0"
                className="w-full border rounded-lg px-3 py-2"
              />
              <p className="text-xs opacity-60 mt-1">Est. shares: {fmt(previewShares, vDec)}</p>
              {(belowMinDep || aboveMaxDep || overAvailDep) && (
                <p className="text-xs text-red-600 mt-1">
                  {belowMinDep && 'Below min deposit. '}
                  {aboveMaxDep && 'Above max deposit. '}
                  {overAvailDep && 'Exceeds available to deposit. '}
                </p>
              )}
            </div>

            <button
              disabled={!isConnected || !assetAddress || depAmount === 0n || Boolean(paused) || belowMinDep || aboveMaxDep || overAvailDep || wrongChain || isWriting}
              className="px-3 py-2 rounded-lg bg-black text-white disabled:opacity-40"
              onClick={async () => {
                if (!address || !assetAddress) return

                try {
                  // If allowance < deposit, approve first
                  if ((allowance ?? 0n) < depAmount) {
                    const approveTx = await writeContractAsync({
                      abi: ERC20_ABI,
                      address: assetAddress as `0x${string}`,
                      functionName: 'approve',
                      args: [VAULT_ADDRESS, depAmount],
                    })
                    console.log('approve tx', approveTx)
                  }

                  // Then deposit
                  const depositTx = await writeContractAsync({
                    abi: VAULT_ABI,
                    address: VAULT_ADDRESS,
                    functionName: 'deposit',
                    args: [depAmount, address],
                  })
                  console.log('deposit tx', depositTx)
                  setDepInput('')
                } catch (err) {
                  console.error('Deposit flow failed', err)
                }
              }}
            >
              {isWriting ? 'Processing…' : 'Deposit'}
            </button>
          </div>
        </Card>

        {/* Redeem */}
        <Card title="Redeem (shares → assets)">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-sm mb-1">Shares</label>
              <input
                value={redInput}
                onChange={(e) => setRedInput(e.target.value)}
                placeholder="0.0"
                className="w-full border rounded-lg px-3 py-2"
              />
              <p className="text-xs opacity-60 mt-1">Est. assets: {fmt(previewAssets, aDec)} {tokenSymbol ?? ''}</p>
              {(belowMinWdr || aboveMaxWdr) && (
                <p className="text-xs text-red-600 mt-1">
                  {belowMinWdr && 'Below min withdraw. '}
                  {aboveMaxWdr && 'Above max withdraw. '}
                </p>
              )}
            </div>
            <button
              disabled={!isConnected || redShares === 0n || Boolean(paused) || wrongChain}
              className="px-3 py-2 rounded-lg bg-black text-white disabled:opacity-40"
              onClick={async () => {
                if (!address) return
                const tx = await writeContractAsync({
                  abi: VAULT_ABI,
                  address: VAULT_ADDRESS,
                  functionName: 'redeem',
                  args: [redShares, address, address],
                })
                console.log('redeem tx', tx)
                setRedInput('')
              }}
            >Redeem</button>
          </div>
        </Card>

        <footer className="text-xs opacity-60 pt-4">
          USDC (Sepolia) reference address (from Circle docs): 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 — but the dApp auto-reads your vault’s asset().
        </footer>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <h2 className="text-lg font-medium mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Row({ label, value }: { label: string, value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="opacity-60">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

/*****************************
 * 6) App Providers
 *****************************/
export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={qc}>
        <RainbowKitProvider>
          <Screen />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
