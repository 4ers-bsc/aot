# FIGHT10 — Content Pack

> Source of truth: the in-app whitepaper, landing page, tutorial, and network
> config. All numbers below are the shipped values (10,000 entry / 90% winner /
> 10% protocol fee). No secrets, private keys, thresholds, or exploit surface
> are included — thresholds and identifiers are withheld by design, exactly as
> the in-app whitepaper states.

---

## Quick facts (for reference)

- **Game:** FIGHT10 — *last one standing*. Skill-based, top-down PvP arena.
- **Chain:** Robinhood Chain — an Ethereum L2 on the Arbitrum Orbit stack (chain ID 4663).
- **Token:** $FIGHT10 (standard ERC-20).
- **Entry:** 10,000 $FIGHT10 per player. **Winner takes 90%** of the pot; **10% protocol fee** funds the arena.
- **Modes:** Demo (free vs CPU) · Duel (2p, 5 min) · 5-Player FFA (7 min) · 10-Player FFA (10 min).
- **Pots:** Duel 20k → 18k to winner · 5-FFA 50k → 45k · 10-FFA 100k → 90k.
- **Loadout:** everyone spawns identical — same HP, same attack, all 4 weapons. Frag (AoE), Sword (melee, top damage), Pistol (mid-range), Sniper (long-range charge).
- **Map:** trees & mountains block movement and deflect attacks; the river halves your speed and damage.
- **Auth:** Sign in with Web3 (SIWE). One wallet → one active match at a time.
- **Handle:** [@fight10_club](https://x.com/fight10_club)
- *For entertainment purposes only. Not financial advice.*

---

## Tweets by style

### Launch / Hype
1. 10,000 $FIGHT10 in. One fighter walks out with 90% of the pot. No luck, no house edge, no pay-to-win — just skill and the will to be the last one standing. The arena is open. ⚔️
2. Same health. Same weapons. Same spawn. The only variable is you. FIGHT10 is live. 🩸
3. Last one standing takes the pot. Everyone else takes the lesson. Welcome to FIGHT10.

### Degen / crypto-native
4. stake 10k $FIGHT10, outlast the lobby, take 90% of the pot. escrow verified on-chain end to end, payout straight to your wallet with a confirmed tx hash. the only PvP where you farm other players, not a curve. gm to the last one standing 🩸
5. no emissions. no farm. no ponzi mechanics. you win by being better than nine other people in a trench. that's the whole game. $FIGHT10
6. pot is 100k. 10 enter. 1 leaves with 90k. math is simple, the trench is not. 🪖

### Minimal / brand
7. Enter. Outlast. Collect. — FIGHT10
8. Last one standing. Nothing else counts.
9. Same kit. Different outcome.

### Explainer / thread starters
10. How FIGHT10 works, in four steps: 🧵
    1) Connect an EVM wallet
    2) Pay 10,000 $FIGHT10 into on-chain escrow
    3) Fight — everyone starts equal
    4) Be the last alive → 90% of the pot, straight to your wallet
11. "Skill-based" gets thrown around a lot in crypto gaming. Here's what it actually means in FIGHT10: every fighter spawns with identical HP, identical damage, identical weapons. Your wallet size buys a seat and nothing else. 🧵
12. The pot in a 10-player FFA is 100,000 $FIGHT10. Winner takes 90,000. A 10% protocol fee keeps the arena running. That's the entire economic model — no hidden sinks, no rake on top. 👇

### Trust / security (fairness-focused)
13. In FIGHT10 the house can't cheat — and neither can your opponents. Payouts are the *only* outflow from escrow, gated by a verified, finished match with a single confirmed winner. Provably last one standing. 🛡️
14. Nobody in FIGHT10 reports their own survival. You report only the damage *you* dealt; the server derives everyone's remaining HP from what their opponents dealt. You can't inflate your way to a win. Results are earned, not self-declared.
15. Cheaters don't void your match in FIGHT10 — they forfeit. Impossible output removes a fighter from winner selection; the best clean player still wins, and the cheater's entry stays in the pot. Honest players are never punished for someone else's exploit.
16. Deposit-before-join: your seat is granted only *after* the payment clears on-chain — confirmed status, exact amount, correct destination, signed by your own wallet. The browser can't self-admit. No deposit, no entry.
17. The escrow signer never touches a browser. It lives in a privileged server process, and the only thing it's allowed to do is pay a verified winner. That's custody done right.

### Competitive / trash talk
18. Ten fighters queue up sure they're taking the pot. Nine are wrong. 🏆
19. Everyone spawns equal. Two minutes in, that stops being true. See you in the trench.
20. There's no gear check, no whale advantage, no lucky roll to blame. If you lose in FIGHT10, you got outplayed. Rematch? 😏

### Mechanics / gameplay
21. Four weapons, swap anytime with 1–4:
    ① Frag — lobbed AoE, clears clusters
    ② Sword — fastest, highest damage, but you have to close in
    ③ Pistol — quick mid-range, no charge
    ④ Sniper — long-range, hold still to charge, then delete
    Read the range. Pick the tool. $FIGHT10
22. The map fights back. Trees and mountains block movement and deflect shots. The river halves your speed *and* your damage. Positioning is a weapon. 🌲🏔️
23. Frag the cluster, swap to sniper, reposition behind the treeline, close with the sword for the kill. FIGHT10 rewards players who think in ranges.

### Progression / retention
24. Every match moves you up. +10 for playing, +60 for a win, +10 per consecutive win — and the streak bonus escalates the longer you hold it. One loss resets it. How long is your streak? 📈
25. L2 at 100 · L3 at 300 · L4 at 600 · L5 at 1,000 — and it keeps climbing. The leaderboard doesn't care how you got here, only that you keep winning.
26. Win or lose, you leave every FIGHT10 match with points. Win, and you leave with the pot too.

### FOMO / conversion
27. Every second you're not in the arena, someone else is stacking your pot. 10,000 $FIGHT10 buys the seat — skill pays the rest. In, or spectating? 👀
28. New to it? Run a free Demo match against the CPU first, learn the four weapons, then bring 10k to the trench. GL, HF. 🎮

### One-liners / shitposts
29. Financial advice: be the last one standing. (Not financial advice.)
30. My portfolio strategy is a 10-player FFA and unshakeable confidence.
31. "how's the trench" bro I am the trench

---

## Long-form article

### The Trench Doesn't Care About Your Bag: Notes on FIGHT10

*A skill-based arena that treats the browser as hostile and the player as the only edge.*

I've been around long enough to have watched the same movie a dozen times. A
game launches with a token, the token launches with emissions, and the
emissions launch a mercenary economy that plays the spreadsheet instead of the
game. The "play" in play-to-earn quietly becomes a rounding error. By the time
the emissions taper, the only people left are the ones who were never there for
the game in the first place. You know the pattern. So do I. It's why most of us
got cynical about crypto gaming somewhere around the second or third cycle.

So when I opened FIGHT10, my guard was up. A top-down, last-one-standing arena
where you stake an ERC-20 to enter and the survivor takes the pot — on paper
that's either a genuinely clean design or another dressed-up slot machine. The
interesting part is which one, and *why*, and the answer turns out to live in
the boring engineering choices rather than the marketing.

Let me start with the economics, because they're refreshingly small. You pay a
fixed entry — 10,000 $FIGHT10 — into a single pot with everyone else in your
match. Win, and you take 90% of that pot. The remaining 10% is a protocol fee
that funds operations. That's the whole model. There is no yield, no staking
multiplier, no reflection, no second token to farm the first token. A 10-player
free-for-all is a 100,000 $FIGHT10 pot; the last one standing walks with 90,000.
Nothing is minted to make that payout. It's redistribution among players, minus
a transparent rake, settled on-chain. If you've spent any time modelling
tokenomics, you know how rare it is to see a loop this legible. There's nowhere
for inflation to hide because there's no inflation in the loop at all.

The thing that actually earns my respect, though, is a single design sentence
buried in the whitepaper: *the browser and its console are treated as hostile.*
That is the correct threat model, and almost nobody ships it. In most web games
the client is trusted to report what happened, and the "anti-cheat" is a layer
of obfuscation praying nobody opens dev tools. FIGHT10 inverts it. Every fighter
spawns identical — same health, same attack, same four weapons — so there is no
stat to buy and no loadout advantage to grind. Your wallet size purchases a
seat and precisely nothing else. Whatever edge you have has to come out of your
hands.

Then it gets more clever. When the server settles a match, no client is allowed
to report its own survival. Instead, each player reports only the damage *they*
dealt to others, and the server reconstructs everyone's remaining health from
what their *opponents* reported. Sit with that for a second. It means you
cannot inflate your own survival, because you never get to speak about your own
health — only your enemies do, and they have no incentive to keep you alive.
Damage is accepted only inside physically plausible ceilings on rate and total
output, so you can't fabricate a thousand points of damage in a frame. If the
ledger can't resolve a clean winner, the match is held for review and *nobody*
is paid rather than paying the wrong person. That is the posture of people who
have been burned before and decided never again.

The anti-manipulation stance has a second edge that I think is genuinely
player-first: when someone is flagged for impossible output, the match doesn't
void. The cheater is simply excluded from winner selection — the best clean
player still wins, and the cheater forfeits their entry into the pot. Honest
players never eat the cost of someone else's exploit. Contrast that with every
game where one detected cheater nukes the lobby and the nine people who played
fair lose their time and their stake. Forfeit-not-void is a small phrase with a
big philosophy behind it.

Custody is where a lot of "on-chain games" quietly aren't. Here the entry moves
on-chain into a program-controlled escrow, and admission is deposit-*before*-
join: your seat is granted only after a verification service re-checks the
transaction on-chain — confirmed status, exact amount, correct destination, and
that the sender is your own wallet. A fabricated transaction reference fails
verification and never reaches a lobby. The browser cannot self-admit; the
routine that grants seats isn't callable by clients at all. On the way out, the
payout process re-verifies every entry, confirms the caller is the recorded
winner, and atomically reserves a single payout slot so concurrent or repeated
claims can't double-pay. The escrow signer — the one key that can move money —
never touches a browser. Payouts are the *only* outflow escrow permits. If you've
ever audited a system that moves user funds, you recognize the difference between
this and "trust me."

None of that would matter if the game underneath were hollow, so it's worth
saying it isn't. You carry all four weapons and swap between them with 1–4: a
lobbed frag for clustered enemies, a sword that hits hardest but forces you to
close distance, a pistol for quick mid-range work, and a sniper that rewards
holding still to charge. The map is an active participant — trees and mountains
block movement and deflect attacks, and the river halves both your speed and
your damage, which turns terrain into a real tactical decision instead of set
dressing. Matches are short and pointed: five minutes for a duel, seven for a
five-player free-for-all, ten for a ten-player. If the timer expires, the
survivor with the highest health takes it, so there's no stalling your way to a
draw. Progression sits on top — points every match, a bigger reward for wins, an
escalating streak bonus that a single loss resets — the kind of retention loop
that rewards showing up without ever letting you buy your way up the board.

The whole stack runs on Robinhood Chain, an Ethereum L2 built on the Arbitrum
Orbit stack, and the infrastructure choices match the paranoia of the game
logic: on-chain reads and writes fan out across multiple independent endpoints
with round-robin selection and automatic failover, so a single provider getting
rate-limited at a busy join doesn't take the arena down. Auth is Sign in with
Web3 — you prove the wallet, and one wallet maps to one active match at a time.

Am I telling you to go stake your rent? No — and neither is the game, which
plasters "for entertainment purposes only, not financial advice" across its own
footer, which I appreciate more than the projects that imply the opposite. What
I'm saying is narrower and, coming from me, rarer: this is a design that took
the adversarial reality of on-chain PvP seriously *before* shipping. Equal
spawns kill pay-to-win. Server-authoritative settlement from opponent-reported
damage kills self-inflation. Deposit-before-join and single-slot payouts kill
the custody games. Forfeit-not-void protects the honest majority. None of these
are flashy. All of them are the things that were missing every previous time
this genre disappointed you.

The trench, as the game likes to remind you when you die in it, doesn't care
about your bag. Ten fighters spawn identical and one walks out with the pot. For
once, the only thing standing between those two states is skill — and a
back-end that was built assuming everyone would try to cheat it. In this corner
of the market, that assumption is the whole product.

*Last one standing. Nothing else counts.*

---

*FIGHT10 · [@fight10_club](https://x.com/fight10_club) · For entertainment
purposes only. All $FIGHT10 amounts are shown at token scale and carry no
guaranteed monetary value. Nothing here is financial advice.*
