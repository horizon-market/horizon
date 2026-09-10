import { IDKitInviteCodeRequestWidget, selfieCheckLegacy, type IDKitResult, type RpContext } from '@worldcoin/idkit';

export function WorldVerification({ open, onOpenChange, appId, action, environment, requestId, rpContext, onVerify }: {
  open: boolean; onOpenChange: (open: boolean) => void; appId: string; action: string;
  environment: 'sandbox' | 'staging' | 'production'; requestId: string; rpContext: RpContext;
  onVerify: (result: IDKitResult) => Promise<void>;
}) {
  return <IDKitInviteCodeRequestWidget
    open={open}
    onOpenChange={onOpenChange}
    app_id={appId as `app_${string}`}
    action={action}
    rp_context={rpContext}
    allow_legacy_proofs={true}
    environment={environment}
    preset={selfieCheckLegacy({ signal: requestId })}
    handleVerify={onVerify}
    onSuccess={() => onOpenChange(false)}
  />;
}
