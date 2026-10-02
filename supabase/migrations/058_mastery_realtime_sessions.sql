-- Server-owned Live voice sessions. Service role alone can admit and account.
CREATE TABLE public.mastery_realtime_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Keep the recovery record when a user or milestone is deleted mid-call.
  -- Clearing a milestone must never clear its monthly voice reservation.
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  milestone_id uuid REFERENCES public.milestones(id) ON DELETE SET NULL,
  provider_call_id text UNIQUE,
  state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting', 'active', 'ended', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text,
  reserved_usd numeric(10,6) NOT NULL,
  observed_usd numeric(10,6) NOT NULL DEFAULT 0,
  audio_in bigint NOT NULL DEFAULT 0,
  audio_out bigint NOT NULL DEFAULT 0,
  text_in bigint NOT NULL DEFAULT 0,
  text_out bigint NOT NULL DEFAULT 0,
  transcription_in bigint NOT NULL DEFAULT 0,
  transcription_out bigint NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mastery_realtime_sessions_open ON public.mastery_realtime_sessions (deadline_at)
  WHERE state IN ('starting', 'active');
CREATE INDEX mastery_realtime_sessions_budget ON public.mastery_realtime_sessions (user_id, started_at);
ALTER TABLE public.mastery_realtime_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mastery_realtime_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mastery_realtime_sessions TO service_role;

CREATE TABLE public.mastery_realtime_usage_events (
  session_id uuid NOT NULL REFERENCES public.mastery_realtime_sessions(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, event_key)
);
ALTER TABLE public.mastery_realtime_usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mastery_realtime_usage_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.mastery_realtime_usage_events TO service_role;

-- A global transaction lock makes both the user and workspace checks atomic.
-- A reservation remains charged for the month even if the observer disappears.
CREATE FUNCTION public.start_mastery_realtime_session(
  p_user_id uuid, p_milestone_id uuid, p_seconds integer,
  p_reserve_usd numeric, p_user_budget_usd numeric, p_workspace_budget_usd numeric,
  p_user_concurrency integer, p_workspace_concurrency integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(581162, 1);
  IF (SELECT count(*) FROM public.mastery_realtime_sessions
      WHERE user_id = p_user_id AND state IN ('starting','active')) >= p_user_concurrency
     OR (SELECT count(*) FROM public.mastery_realtime_sessions
      WHERE state IN ('starting','active')) >= p_workspace_concurrency THEN
    RAISE EXCEPTION 'realtime_concurrency_limit';
  END IF;
  IF (SELECT coalesce(sum(greatest(reserved_usd, observed_usd)), 0)
      FROM public.mastery_realtime_sessions WHERE user_id = p_user_id AND started_at >= v_month)
      + p_reserve_usd > p_user_budget_usd
     OR (SELECT coalesce(sum(greatest(reserved_usd, observed_usd)), 0)
      FROM public.mastery_realtime_sessions WHERE started_at >= v_month)
      + p_reserve_usd > p_workspace_budget_usd THEN
    RAISE EXCEPTION 'realtime_budget_limit';
  END IF;
  INSERT INTO public.mastery_realtime_sessions
    (user_id, milestone_id, deadline_at, reserved_usd)
    VALUES (p_user_id, p_milestone_id, now() + make_interval(secs => p_seconds), p_reserve_usd)
    RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.start_mastery_realtime_session(uuid,uuid,integer,numeric,numeric,numeric,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_mastery_realtime_session(uuid,uuid,integer,numeric,numeric,numeric,integer,integer) TO service_role;

-- One provider event, one atomic accounting transaction. Duplicate sideband
-- delivery cannot create duplicate usage_logs or budget spend.
CREATE FUNCTION public.record_mastery_realtime_event(
  p_session_id uuid, p_event_key text, p_audio_in integer, p_audio_out integer,
  p_text_in integer, p_text_out integer, p_transcription_in integer,
  p_transcription_out integer, p_cost_usd numeric, p_period_start timestamptz
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_user_id uuid; v_total numeric;
BEGIN
  INSERT INTO public.mastery_realtime_usage_events(session_id, event_key)
    VALUES (p_session_id, p_event_key) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT observed_usd INTO v_total FROM public.mastery_realtime_sessions WHERE id = p_session_id;
    RETURN v_total;
  END IF;
  SELECT user_id INTO v_user_id FROM public.mastery_realtime_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_user_id IS NULL OR p_cost_usd < 0 THEN RAISE EXCEPTION 'invalid_realtime_usage'; END IF;
  UPDATE public.mastery_realtime_sessions SET
    observed_usd = observed_usd + p_cost_usd,
    audio_in = audio_in + p_audio_in, audio_out = audio_out + p_audio_out,
    text_in = text_in + p_text_in, text_out = text_out + p_text_out,
    transcription_in = transcription_in + p_transcription_in,
    transcription_out = transcription_out + p_transcription_out,
    last_activity_at = now()
    WHERE id = p_session_id RETURNING observed_usd INTO v_total;
  IF p_audio_in + p_audio_out > 0 THEN
    INSERT INTO public.usage_logs(user_id, feature, model, tokens_in, tokens_out)
      VALUES(v_user_id, 'mastery/realtime', 'gpt-realtime-mini', p_audio_in, p_audio_out);
  END IF;
  IF p_text_in + p_text_out > 0 THEN
    INSERT INTO public.usage_logs(user_id, feature, model, tokens_in, tokens_out)
      VALUES(v_user_id, 'mastery/realtime', 'gpt-realtime-mini-text', p_text_in, p_text_out);
  END IF;
  IF p_transcription_in + p_transcription_out > 0 THEN
    INSERT INTO public.usage_logs(user_id, feature, model, tokens_in, tokens_out)
      VALUES(v_user_id, 'mastery/realtime', 'gpt-4o-mini-transcribe', p_transcription_in, p_transcription_out);
  END IF;
  PERFORM public.record_usage(v_user_id, p_period_start,
    p_audio_in + p_audio_out + p_text_in + p_text_out + p_transcription_in + p_transcription_out);
  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.record_mastery_realtime_event(uuid,text,integer,integer,integer,integer,integer,integer,numeric,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_mastery_realtime_event(uuid,text,integer,integer,integer,integer,integer,integer,numeric,timestamptz) TO service_role;
