-- Keep one latest report per target and persistent device reporter.
alter table public.ai_reply_reports
  drop constraint if exists ai_reply_reports_report_target_id_key,
  add column if not exists reporter_id text;

update public.ai_reply_reports set reporter_id = 'legacy:' || id::text where reporter_id is null;
alter table public.ai_reply_reports alter column reporter_id set not null;
drop function if exists public.save_ai_reply_report(text, text, text, text, text, timestamptz);
alter table public.ai_reply_reports
  add constraint ai_reply_reports_reporter_id_length_check check (char_length(reporter_id) between 1 and 128),
  add constraint ai_reply_reports_report_target_id_length_check check (char_length(report_target_id) between 1 and 4096),
  add constraint ai_reply_reports_news_url_length_check check (char_length(news_url) between 1 and 4096),
  add constraint ai_reply_reports_reply_text_length_check check (char_length(reply_text) between 1 and 10000),
  add constraint ai_reply_reports_target_reporter_key unique (report_target_id, reporter_id);

create or replace function public.save_ai_reply_report(
  p_report_target_id text, p_news_url text, p_reply_text text,
  p_report_type text, p_note text, p_updated_at timestamptz default null,
  p_reporter_id text default null
)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_report_target_id is null or char_length(p_report_target_id) not between 1 and 4096 then raise exception 'Invalid report target'; end if;
  if p_reporter_id is null or char_length(p_reporter_id) not between 1 and 128 then raise exception 'Invalid reporter'; end if;
  if p_news_url is null or char_length(p_news_url) not between 1 and 4096 then raise exception 'Invalid news URL'; end if;
  if p_reply_text is null or char_length(p_reply_text) not between 1 and 10000 then raise exception 'Invalid reply text'; end if;
  if p_report_type is null or p_report_type not in ('dislike_or_display_issue', 'harmful_or_abusive', 'incorrect_content', 'other') then raise exception 'Invalid report type'; end if;
  if p_note is not null and char_length(p_note) > 200 then raise exception 'Invalid report note'; end if;
  insert into public.ai_reply_reports (report_target_id, reporter_id, news_url, reply_text, report_type, note, updated_at)
  values (p_report_target_id, p_reporter_id, p_news_url, p_reply_text, p_report_type,
    case when p_report_type = 'other' then p_note else null end, now())
  on conflict (report_target_id, reporter_id) do update set
    news_url = excluded.news_url, reply_text = excluded.reply_text,
    report_type = excluded.report_type, note = excluded.note, updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.save_ai_reply_report(text, text, text, text, text, timestamptz, text) from public;
grant execute on function public.save_ai_reply_report(text, text, text, text, text, timestamptz, text) to anon, authenticated;
