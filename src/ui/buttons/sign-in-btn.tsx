'use client'

import { useState, useEffect, useRef } from 'react'
import { useSignMessage, useChainId, useDisconnect, useConnection } from 'wagmi'
import { SiweMessage } from 'siwe'
import { useConnectModal, useXellarAccount } from '@xellar/kit'
import { useUser } from '@/hooks/useUser'
import {
  generateSiweNonce,
  verifySiweMessage,
  destroySession,
} from '@/actions/auth'

// Sign-in intent persists across the page reload that Xellar performs after
// successful OTP. Without this, the auto-SIWE effect's gate is reset and the
// user is bounced back to the "Sign In" button instead of finishing login.
const SIGN_IN_INTENT_KEY = 'encoteki:sign-in-intent'
const XELLAR_CONNECTOR_ID = 'xellar-passport'

const readIntent = () => {
  if (typeof window === 'undefined') return false
  return window.sessionStorage.getItem(SIGN_IN_INTENT_KEY) === '1'
}
const writeIntent = (on: boolean) => {
  if (typeof window === 'undefined') return
  if (on) window.sessionStorage.setItem(SIGN_IN_INTENT_KEY, '1')
  else window.sessionStorage.removeItem(SIGN_IN_INTENT_KEY)
}

export function SignInButton() {
  const { open } = useConnectModal()
  const xellarAccount = useXellarAccount()
  const connection = useConnection()
  const { address, isConnected } = connection
  const connectorId = connection.connector?.id
  const chainId = useChainId()
  const signMessage = useSignMessage()
  const disconnect = useDisconnect()
  const { isLoggedIn, isLoading: isSessionLoading, mutate } = useUser()
  const [isSigningIn, setIsSigningIn] = useState(false)
  // Mirror sessionStorage into a ref so we can read it synchronously inside
  // effects without an extra render. Hydrated once on mount.
  const shouldSignRef = useRef(false)
  // Set true when the user opens Xellar's external permission tab. On focus
  // return we trigger a sign attempt — Xellar's internal request handler
  // refreshes the wallet token (and the `isPermissionGranted` flag derived
  // from it) before processing the request, so this both updates UI state
  // and completes login in one step.
  const attemptedPermissionRef = useRef(false)
  const [hasMounted, setHasMounted] = useState(false)

  useEffect(() => {
    shouldSignRef.current = readIntent()
    setHasMounted(true)
  }, [])

  // Login SIWE
  const handleLogin = async () => {
    try {
      if (!address || !chainId) return
      setIsSigningIn(true)

      const nonce = await generateSiweNonce()

      // 10-minute signing window. Tight enough to make captured signatures
      // useless after the user walks away, loose enough that a slow signer
      // (cold wallet, mobile relay) doesn't get rejected.
      const issuedAt = new Date()
      const expirationTime = new Date(issuedAt.getTime() + 10 * 60 * 1000)

      const message = new SiweMessage({
        domain: window.location.host,
        address: address,
        statement: 'Sign in to Encoteki Beta App',
        uri: window.location.origin,
        version: '1',
        chainId: chainId,
        nonce: nonce,
        issuedAt: issuedAt.toISOString(),
        expirationTime: expirationTime.toISOString(),
      })

      const messageToSign = message.prepareMessage()
      const signature = await signMessage.mutateAsync({
        message: messageToSign,
      })

      const result = await verifySiweMessage(messageToSign, signature)

      if (!result.success) throw new Error('Failed to verify')

      await mutate()

      shouldSignRef.current = false
      writeIntent(false)
    } catch (error) {
      // Never auto-disconnect here. If signing fails for any reason
      // (user cancels, Xellar still finishing setup, network blip), keep
      // the wallet connected so the user can retry without redoing OTP.
      // Disconnect is reserved for the explicit Disconnect button.
      console.error('Login Error:', error)
      shouldSignRef.current = false
      writeIntent(false)
    } finally {
      setIsSigningIn(false)
    }
  }

  // Logout
  const handleLogout = async () => {
    try {
      await destroySession()
      if (isConnected) {
        await disconnect.mutateAsync()
      }
      await mutate(undefined, false)
      shouldSignRef.current = false
      writeIntent(false)
      window.location.href = '/login'
    } catch (error) {
      console.error('Failed to logout:', error)
    }
  }

  // For Xellar email logins, `xellarAccount` is non-null and
  // `isPermissionGranted` is false until the user accepts permission. For
  // external wallets `xellarAccount` is null and we sign immediately.
  const isXellarConnector = connectorId === XELLAR_CONNECTOR_ID
  // After Xellar's post-OTP page refresh there is a brief window where the
  // wagmi connector has rehydrated (isConnected=true, connectorId=xellar-passport)
  // but Xellar's own zustand store hasn't replayed yet (xellarAccount=null).
  // We must wait — otherwise we'd misread it as an external wallet and fire SIWE.
  const isXellarHydrating = isXellarConnector && xellarAccount === null
  const isXellarPermissionPending =
    xellarAccount !== null && !xellarAccount.isPermissionGranted

  const isFinalizing =
    hasMounted &&
    shouldSignRef.current &&
    isConnected &&
    !isLoggedIn &&
    (isXellarHydrating || isSigningIn)

  // Auto-trigger SIWE once everything Xellar needs to do is done.
  // We do NOT call close() here — Xellar manages its own modal lifecycle,
  // and forcing close during in-flight wallet creation aborts the flow.
  useEffect(() => {
    if (
      hasMounted &&
      isConnected &&
      address &&
      shouldSignRef.current &&
      !isLoggedIn &&
      !isSigningIn &&
      !isXellarHydrating &&
      !isXellarPermissionPending
    ) {
      handleLogin()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasMounted,
    isConnected,
    address,
    isLoggedIn,
    isSigningIn,
    isXellarHydrating,
    isXellarPermissionPending,
  ])

  // When the user returns from the permission tab, attempt a sign. Xellar's
  // request handler calls `ce()` first, which refreshes the wallet token —
  // updating `isPermissionGranted` in zustand. If permission is now granted,
  // SIWE goes through and login completes; if not, we just reset and the UI
  // re-renders with whatever fresh state the refresh produced.
  useEffect(() => {
    const onFocus = () => {
      if (!attemptedPermissionRef.current) return
      if (!isConnected || !address || isLoggedIn || isSigningIn) return
      attemptedPermissionRef.current = false
      handleLogin()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, isLoggedIn, isSigningIn])

  const openPermissionTab = () => {
    const url = xellarAccount?.acceptPermissionPage
    if (!url) return
    attemptedPermissionRef.current = true
    // Same-tick window.open inside a user gesture so popup blockers allow it.
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleClick = () => {
    if (!isConnected) {
      shouldSignRef.current = true
      writeIntent(true)
      open()
    } else if (isXellarPermissionPending) {
      // After Xellar's post-OTP refresh, the SDK's permission modal does NOT
      // re-mount on its own — it only shows in response to a personal_sign
      // call. Going through signMessage would race / error, so we open the
      // permission page directly (same thing the SDK's own button does).
      openPermissionTab()
    } else {
      handleLogin()
    }
  }

  // --- Render --------------------------------------------------------------

  if (isSessionLoading || !hasMounted) {
    return (
      <ButtonShell variant="muted" disabled>
        <Loading label="Loading…" />
      </ButtonShell>
    )
  }

  if (isLoggedIn && isConnected) {
    return (
      <ButtonShell variant="danger" onClick={handleLogout}>
        Sign Out
      </ButtonShell>
    )
  }

  // Mid-flow states (signed wallet-side, still finishing on app-side)
  if (isFinalizing) {
    return (
      <ButtonShell variant="primary" disabled>
        <Loading
          label={isSigningIn ? 'Signing you in…' : 'Almost done…'}
        />
      </ButtonShell>
    )
  }

  if (isXellarPermissionPending) {
    const hasUrl = Boolean(xellarAccount?.acceptPermissionPage)
    return (
      <div className="flex w-full flex-col items-center gap-1.5 tablet:w-auto">
        <ButtonShell
          variant="primary"
          onClick={handleClick}
          disabled={!hasUrl}
        >
          {hasUrl ? 'Authorize Account' : <Loading label="Getting ready…" />}
        </ButtonShell>
        <p className="text-xs text-neutral-40">
          Authorize in the new tab to continue.
        </p>
      </div>
    )
  }

  // Connected wallet but no SIWE yet (rare: e.g. external wallet, page revisit)
  if (isConnected) {
    return (
      <ButtonShell
        variant="primary"
        onClick={handleClick}
        disabled={isSigningIn}
      >
        {isSigningIn ? <Loading label="Signing you in…" /> : 'Continue'}
      </ButtonShell>
    )
  }

  return (
    <ButtonShell variant="primary" onClick={handleClick}>
      Sign In
    </ButtonShell>
  )
}

// -- Subcomponents ----------------------------------------------------------

function ButtonShell({
  children,
  onClick,
  disabled,
  variant,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  variant: 'primary' | 'danger' | 'muted'
}) {
  const base =
    'w-full rounded-full px-5 py-3 text-sm font-medium transition-all duration-200 outline-none active:scale-[0.98] disabled:cursor-not-allowed tablet:w-auto tablet:py-2.5'
  const styles = {
    primary:
      'bg-primary-green text-white shadow-[0_4px_12px_rgba(36,98,52,0.2)] hover:bg-primary-green/90 hover:shadow-[0_6px_16px_rgba(36,98,52,0.3)] focus-visible:ring-2 focus-visible:ring-primary-green focus-visible:ring-offset-2 disabled:opacity-70 disabled:hover:bg-primary-green disabled:hover:shadow-none',
    danger:
      'bg-white text-primary-red shadow-sm ring-1 ring-neutral-60/20 hover:bg-red-50 hover:shadow focus-visible:ring-2 focus-visible:ring-primary-red',
    muted:
      'flex items-center justify-center bg-neutral-60/20 text-neutral-40',
  }[variant]
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  )
}

function Loading({ label = 'Loading…' }: { label: string }) {
  return (
    <span className="flex w-full items-center justify-center gap-2">
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
          fill="none"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      {label}
    </span>
  )
}
