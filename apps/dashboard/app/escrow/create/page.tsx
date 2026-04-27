'use client';

import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Lock, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import type { EscrowState } from '../../../components/escrow/Step1Service';
import { Step1Service } from '../../../components/escrow/Step1Service';
import { Step2SLA } from '../../../components/escrow/Step2SLA';
import { Step3Fees } from '../../../components/escrow/Step3Fees';
import { Step4Review } from '../../../components/escrow/Step4Review';
import { StepIndicator } from '../../../components/escrow/StepIndicator';
import { Button } from '../../../components/ui/Button';
import type { Listing } from '../../../lib/api';
import { fetchListing, toUsdc } from '../../../lib/api';
import { DEVNET_USDC_MINT } from '../../../lib/cluster';
import { createSdk } from '../../../lib/sdk';

const TOTAL_STEPS = 4;

function CreateEscrowInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const listingPubkey = searchParams.get('listing') ?? '';
  const { connection } = useConnection();
  const { publicKey, wallet, connected } = useWallet();

  const [listing, setListing] = React.useState<Listing | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [step, setStep] = React.useState(1);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = React.useState<number | null>(null);

  const [escrowState, setEscrowState] = React.useState<EscrowState>({
    selectedListing: null,
    serviceIndex: 0,
    quantity: 1,
    slaLatency: 5000,
    slaUptime: 99,
    slaFormat: 'text',
    timeout: '48h',
    insurance: false,
  });

  // Load listing
  React.useEffect(() => {
    if (!listingPubkey) {
      setLoading(false);
      return;
    }
    fetchListing(listingPubkey).then((l) => {
      setListing(l);
      if (l) {
        setEscrowState((prev) => ({
          ...prev,
          selectedListing: l,
          slaLatency: l.sla.maxLatencyMs ?? 5000,
          slaUptime: l.sla.minUptimePct ?? 99,
          slaFormat: l.sla.responseFormat ?? 'text',
        }));
      }
      setLoading(false);
    });
  }, [listingPubkey]);

  // Fetch USDC balance
  React.useEffect(() => {
    if (!publicKey) {
      setUsdcBalance(null);
      return;
    }
    let cancelled = false;

    async function fetchUsdcBalance() {
      try {
        const { PublicKey } = await import('@solana/web3.js');
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey!, {
          mint: new PublicKey(DEVNET_USDC_MINT),
        });
        if (!cancelled) {
          const first = tokenAccounts.value[0];
          setUsdcBalance(
            first != null ? (first.account.data.parsed.info.tokenAmount.uiAmount as number) : 0,
          );
        }
      } catch {
        if (!cancelled) setUsdcBalance(0);
      }
    }
    void fetchUsdcBalance();
    return () => {
      cancelled = true;
    };
  }, [publicKey, connection]);

  const updateState = (updates: Partial<EscrowState>) =>
    setEscrowState((prev) => ({ ...prev, ...updates }));

  const handleNext = () => {
    if (step < TOTAL_STEPS) setStep((s) => s + 1);
  };

  const handleBack = () => {
    if (step > 1) setStep((s) => s - 1);
  };

  const handleDeposit = async () => {
    if (!connected || !publicKey || !wallet || !listing) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const sdk = createSdk(wallet.adapter as unknown as AnchorWallet);
      const timeoutSeconds =
        {
          '24h': 24 * 3600,
          '48h': 48 * 3600,
          '72h': 72 * 3600,
          '7d': 7 * 24 * 3600,
        }[escrowState.timeout] ?? 48 * 3600;

      const budget = BigInt(
        Math.round(toUsdc(listing.priceUsdc) * escrowState.quantity * 1_000_000),
      );

      const result = await sdk.hire(listing.pubkey, {
        budget,
        sla: {
          maxLatencyMs: escrowState.slaLatency,
          minUptimePct: escrowState.slaUptime,
          responseFormat: escrowState.slaFormat,
        },
        timeout: timeoutSeconds,
      });

      router.push(`/my?escrow=${result.escrowPda.toBase58()}`);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Transaction failed.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  const price = toUsdc(escrowState.selectedListing?.priceUsdc ?? 0);
  const total = price * escrowState.quantity;
  const hasEnough = usdcBalance !== null && usdcBalance >= total;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-card rounded-2xl border border-border shadow-lg overflow-hidden">
        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-border relative">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="font-serif text-3xl mb-1">Create escrow</h1>
              <p className="text-xs font-mono text-muted">bazaar-escrow · Solana Devnet</p>
            </div>
            <StepIndicator currentStep={step} />
          </div>
          <button
            type="button"
            onClick={() => router.back()}
            className="absolute top-8 right-8 text-muted hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-8 py-6 min-h-[360px]">
          {step === 1 && (
            <Step1Service
              listings={listing ? [listing] : []}
              state={escrowState}
              onChange={updateState}
            />
          )}
          {step === 2 && <Step2SLA state={escrowState} onChange={updateState} />}
          {step === 3 && (
            <Step3Fees state={escrowState} onChange={updateState} usdcBalance={usdcBalance} />
          )}
          {step === 4 && <Step4Review state={escrowState} onChange={updateState} />}

          {submitError && (
            <div className="mt-4 rounded-lg bg-destructive border border-destructive-text/20 px-4 py-3 text-sm text-destructive-text">
              {submitError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-8 py-5 bg-background border-t border-border">
          <p className="text-sm text-muted">
            Step {step} of {TOTAL_STEPS}
          </p>
          <div className="flex items-center gap-3">
            {step > 1 && (
              <Button variant="outline" onClick={handleBack} disabled={submitting}>
                Back
              </Button>
            )}
            {step < TOTAL_STEPS ? (
              <Button onClick={handleNext}>Next</Button>
            ) : (
              <Button
                onClick={handleDeposit}
                loading={submitting}
                disabled={!hasEnough || !connected}
                className="bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
              >
                <Lock className="h-4 w-4" />
                Deposit &amp; Start
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CreateEscrowPage() {
  return (
    <React.Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      }
    >
      <CreateEscrowInner />
    </React.Suspense>
  );
}
