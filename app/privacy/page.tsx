import Link from "next/link";
import type { Metadata } from "next";

// The privacy disclosure. Deliberately PUBLIC — no verifyUserAccess — because a
// privacy notice that can only be read after signing up is no notice at all.
// Route gating in this app lives in the pages themselves, so omitting the check
// is all that is required (proxy.ts only refreshes sessions).
//
// Standard headings, Hugh-specific facts. A boilerplate template would claim
// things untrue here (advertising, analytics partners, data sharing) and omit
// the things that matter and are genuinely unusual — that an uploaded
// screenshot is read by a vision model, and that voice is transcribed by
// Google via the browser — or, with MASTERY_REALTIME_ENABLED, streamed straight
// from the browser to OpenAI. The OpenAI wording is conditional so the page stays
// true whichever way that flag is set; if the recap route ever starts persisting
// the transcript, "What Hugh does not store" becomes false.
//
// Rule 4 exception: this scrolls, for the same reason the landing page does.
// It is a document, not a teaching surface.

export const metadata: Metadata = {
  title: "Privacy — Hugh",
  description: "What Hugh stores, who processes it, how long it is kept, and how to delete it.",
};

const LAST_UPDATED = "17 September 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-400">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#0F172A]">
      <div className="mx-auto max-w-2xl px-6 py-16">

        <Link href="/" className="text-xs text-slate-600 transition-colors hover:text-slate-400">
          ← Hugh
        </Link>

        <h1 className="mt-6 text-3xl font-bold tracking-tight text-slate-100">Privacy</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {LAST_UPDATED}</p>

        <p className="mt-6 text-sm leading-relaxed text-slate-400">
          Hugh is a learning tool for data and analytics. This page describes what it
          stores about you, who else sees it, how long it is kept, and how to remove
          it. It is written to be accurate rather than reassuring — where something
          leaves our systems, it says so.
        </p>

        <Section title="What Hugh stores">
          <p><strong className="text-slate-300">Your account.</strong> Your email address, and
            whether the account is approved or blocked. Passwords are handled by our
            authentication provider and are never visible to us.</p>
          <p><strong className="text-slate-300">What you write.</strong> The topics you choose,
            your answers to the questions Hugh asks before building a track, your learning
            diary, your notes, and your messages to the tutor.</p>
          <p><strong className="text-slate-300">What you upload.</strong> If those features are
            switched on for your account: screenshots you add to Notes, and documents such as
            CVs or job descriptions. They are off by default and are not available to most
            accounts.</p>
          <p><strong className="text-slate-300">How you use Hugh.</strong> Which parts you opened
            and on which days, and a record of tokens used so your monthly allowance can be
            enforced.</p>
          <p><strong className="text-slate-300">What Hugh does not store.</strong> Your voice.
            When you speak in the Prove-it exercise, Hugh keeps no recording, and the
            transcript of a live voice session is used once to write your recap and then
            discarded.</p>
        </Section>

        <Section title="Who else processes it">
          <p>
            Hugh is built on AI models it does not run itself. To answer you, parts of
            what you write are sent to the companies below. We do not sell your data,
            we do not share it for advertising, and Hugh runs no third-party analytics
            or advertising trackers.
          </p>
          <ul className="mt-3 space-y-3">
            <li><strong className="text-slate-300">Anthropic (Claude)</strong> — receives your
              topic, your answers, diary entries and tutor messages, to generate and teach
              your track — and, after a live voice session, the text transcript of that
              conversation, to write your recap. Anthropic states it does not use commercial API data to train its
              models by default.</li>
            <li><strong className="text-slate-300">OpenAI</strong> — receives screenshots you
              upload to Notes, so a vision model can read and comment on them, and some text
              for summarising. If the live voice version of the Prove-it exercise is switched
              on, OpenAI also receives <strong className="text-slate-300">your voice</strong>:
              your browser streams the audio of the conversation directly to OpenAI, which
              transcribes it and replies aloud, together with the card&apos;s summary or your
              diary notes for that card so the coach knows what you studied. OpenAI states
              that API data is not used to train its models unless you opt in, and that it
              may retain it for up to 30 days for abuse monitoring.</li>
            <li><strong className="text-slate-300">ElevenLabs</strong> — receives the text Hugh
              speaks aloud, to turn it into audio. It receives text, not your voice.</li>
            <li><strong className="text-slate-300">Google</strong> — when you speak to Hugh in the
              standard Prove-it exercise (not the live voice version above), transcription uses your browser&apos;s built-in speech
              recognition. In Chrome that is not processed on your device: your browser sends
              the audio to Google to be transcribed. Hugh receives only the text back.</li>
            <li><strong className="text-slate-300">Supabase and Vercel</strong> — host the database
              and the application itself, so your data is stored on their infrastructure.</li>
          </ul>
          <p className="text-xs text-slate-500">
            These providers set their own terms, and those terms can change. The
            descriptions above reflect their published positions when this page was last
            updated.
          </p>
        </Section>

        <Section title="How long it is kept">
          <p>
            Until you delete it. Hugh does not expire your learning data on a timer —
            a diary you wrote a year ago is still worth having. Deleting your account
            removes it.
          </p>
        </Section>

        <Section title="Deleting your account">
          <p>
            You can delete your account at any time from{" "}
            <Link href="/account" className="text-sky-400 underline-offset-2 hover:underline">
              your account settings
            </Link>. It removes your tracks, milestones and diary, your notes and any
            uploaded screenshots, anything tracked in Monitor including uploaded documents,
            and your usage history. Files you uploaded are removed from storage, not merely
            unlinked. It cannot be undone.
          </p>
          <p>
            <strong className="text-slate-300">One thing is kept, de-identified.</strong> We
            retain a technical record that a curriculum was generated — how long it took,
            which model, how many milestones, and whether it succeeded. It is used to tell
            whether Hugh is getting better or worse at building courses. Your topic and the
            generated content are erased from it, and it is no longer linked to you or your
            email.
          </p>
          <p>
            If you have lost access to your account and cannot sign in to delete it, email
            us and we will do it for you.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You can ask what Hugh holds about you, ask for it to be corrected, or have it
            deleted — and deletion you can do yourself, immediately, without asking. If you
            want a copy of your data or have a complaint about how it has been handled,
            email us at the address below.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            <span className="text-slate-300">tjmariohn@gmail.com</span>
          </p>
        </Section>

        <p className="mt-12 border-t border-slate-800 pt-6 text-xs leading-relaxed text-slate-600">
          Hugh is a small independent project rather than a company. This page describes
          what it actually does; if something here turns out to be inaccurate, tell us and
          it will be corrected.
        </p>

      </div>
    </div>
  );
}
