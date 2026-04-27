import { Check } from 'lucide-react';
import * as React from 'react';
import { cn } from '../ui/utils';

interface StepIndicatorProps {
  currentStep: number;
  totalSteps?: number;
}

export function StepIndicator({ currentStep, totalSteps = 4 }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-0">
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1;
        const isCompleted = step < currentStep;
        const isCurrent = step === currentStep;

        return (
          <React.Fragment key={step}>
            {/* Step circle */}
            <div
              className={cn(
                'h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold transition-colors',
                isCompleted && 'bg-black text-white',
                isCurrent && 'bg-primary text-white',
                !isCompleted && !isCurrent && 'bg-background border border-border text-muted',
              )}
            >
              {isCompleted ? <Check className="h-4 w-4" /> : step}
            </div>
            {/* Connector line */}
            {step < totalSteps && (
              <div className={cn('h-px w-8 mx-1', step < currentStep ? 'bg-black' : 'bg-border')} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
