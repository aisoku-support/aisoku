-- Run against a disposable database after migrations. All test rows are rolled back.
begin;
do $$
declare
  target_id text := 'test:ai-reply-report:' || txid_current()::text;
begin
  perform public.save_ai_reply_report(
    target_id, 'https://example.com/news', 'original reply',
    'incorrect_content', null, null, repeat('a', 64)
  );
  perform public.save_ai_reply_report(
    target_id, 'https://example.com/news', 'original reply',
    'harmful_or_abusive', null, null, repeat('a', 64)
  );

  if (select count(*) from public.ai_reply_reports
      where report_target_id = target_id) <> 1 then
    raise exception 'same reporter must update one report';
  end if;
  if not exists (select 1 from public.ai_reply_reports
      where report_target_id = target_id and report_type = 'harmful_or_abusive') then
    raise exception 'same reporter update failed';
  end if;
  perform public.save_ai_reply_report(
    target_id, 'https://example.com/news', 'original reply',
    'incorrect_content', null, null, repeat('b', 64)
  );
  if (select count(*) from public.ai_reply_reports where report_target_id = target_id) <> 2 then
    raise exception 'different reporters must create separate reports';
  end if;
  if has_table_privilege('anon', 'public.ai_reply_reports', 'SELECT') then
    raise exception 'report contents must not be publicly readable';
  end if;
end;
$$;
rollback;
