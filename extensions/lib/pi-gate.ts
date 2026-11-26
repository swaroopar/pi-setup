type ConfirmContext = { hasUI?: boolean; ui?: { confirm(title: string, message: string): Promise<boolean> } };
type Block = { block: true; reason: string };

export function failureReason(name: string, error: unknown): string {
	return `${name} extension failed, so it can't check this call: ${error instanceof Error ? error.message : error}`;
}

export async function blockUnlessConfirmed(ctx: ConfirmContext, guardName: string, reason: string): Promise<Block | undefined> {
	if (!ctx.hasUI || !ctx.ui) return { block: true, reason };
	const allowed = await ctx.ui.confirm(`${guardName}: allow this call anyway?`, reason);
	return allowed ? undefined : { block: true, reason: `The user declined. ${reason}` };
}
