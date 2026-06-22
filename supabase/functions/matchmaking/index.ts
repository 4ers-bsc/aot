import { withSupabase } from "npm:@supabase/server";

type MatchAction =
  | "queue"
  | "cancel_queue"
  | "claim_result"
  | "forfeit";

type MatchRequest = {
  action: MatchAction;
  matchId?: string | null;
  winnerUserId?: string | null;
};

async function fetchProfile(ctx: any, userId: string) {
  const { data, error } = await ctx.supabase
    .from("profiles")
    .select("user_id, display_name, gold_balance")
    .eq("user_id", userId)
    .single();

  if (error) throw error;
  return data;
}

async function fetchMatch(ctx: any, matchId: string) {
  const { data, error } = await ctx.supabase
    .from("matches")
    .select("id, status, pot, room_topic, winner_user_id, entry_fee")
    .eq("id", matchId)
    .single();

  if (error) throw error;
  return data;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    try {
      const userId = ctx.userClaims.id;
      const body = (await req.json()) as MatchRequest;
      const action = body.action;

      if (!userId) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      let rpcName = "";
      let rpcArgs: Record<string, unknown> = {};
      let message = "ok";

      switch (action) {
        case "queue":
          rpcName = "admin_queue_match";
          rpcArgs = { p_user_id: userId };
          message = "Queue updated.";
          break;
        case "cancel_queue":
          rpcName = "admin_cancel_waiting_match";
          rpcArgs = { p_user_id: userId };
          message = "Queue cancelled and escrow refunded.";
          break;
        case "claim_result":
          if (!body.matchId || !body.winnerUserId) {
            return Response.json({ error: "matchId and winnerUserId are required" }, { status: 400 });
          }
          rpcName = "admin_claim_match_result";
          rpcArgs = {
            p_user_id: userId,
            p_match_id: body.matchId,
            p_winner_user_id: body.winnerUserId
          };
          message = "Result claim recorded.";
          break;
        case "forfeit":
          if (!body.matchId) {
            return Response.json({ error: "matchId is required" }, { status: 400 });
          }
          rpcName = "admin_forfeit_match";
          rpcArgs = { p_user_id: userId, p_match_id: body.matchId };
          message = "Match forfeited.";
          break;
        default:
          return Response.json({ error: "unsupported action" }, { status: 400 });
      }

      const { data: result, error } = await ctx.supabaseAdmin.rpc(rpcName, rpcArgs);
      if (error) {
        console.error(error);
        return Response.json({ error: error.message }, { status: 400 });
      }

      const profile = await fetchProfile(ctx, userId);
      const matchId = result?.match_id ?? body.matchId ?? null;
      const match = matchId ? await fetchMatch(ctx, matchId) : null;

      return Response.json({
        ok: true,
        message,
        result,
        profile,
        match
      });
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: error instanceof Error ? error.message : "unexpected_error" },
        { status: 500 }
      );
    }
  })
};
