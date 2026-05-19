'use client'

import React from 'react'
import { Config, cookieStorage, createStorage, WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { XellarKitProvider, defaultConfig, darkTheme } from '@xellar/kit'
// Lazy load chains to reduce initial bundle size
import { base, arbitrum, lisk, manta } from 'viem/chains'

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || ''
const xellarAppId = process.env.NEXT_PUBLIC_XELLAR_APP_ID || ''

// Memoize config to prevent recreation on every render
const config = defaultConfig({
  appName: 'Encoteki',
  ssr: true,
  storage: createStorage({
    storage: cookieStorage,
  }),
  walletConnectProjectId,
  xellarAppId,
  xellarEnv: 'production',
  // Only load production chains to reduce initial load
  chains: [base, arbitrum, lisk, manta],
}) as Config

// Create query client once to avoid recreation
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reduce refetch frequency to improve performance
      staleTime: 60 * 1000, // 1 minute
      gcTime: 5 * 60 * 1000, // 5 minutes (formerly cacheTime)
    },
  },
})

export const Web3Provider = ({ children }: { children: React.ReactNode }) => {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <XellarKitProvider theme={darkTheme}>{children}</XellarKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
