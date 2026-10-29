-- corpgroup.com · 0048 unread chat messages for the menu badge
--
-- COMMS-07 (new-message notifications) and the decision of 29 Oct 2026: the Chat menu item shows how many
-- messages are waiting, a popup announces each new one, and opening a chat clears its count.
-- Counts the caller's unread messages in one company: chats they are in, not muted, sent by someone else,
-- not deleted, newer than when they last read that chat (the same rule as the per-chat counts on the Chat page).

create or replace function public.chat_unread(p_company uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.conversation_members cm
  join public.messages m on m.conversation_id = cm.conversation_id
       and m.created_at > cm.last_read_at and m.sender_id <> cm.user_id and not m.deleted
  where cm.user_id = auth.uid() and cm.company_id = p_company and not cm.muted;
$$;

revoke execute on function public.chat_unread(uuid) from public, anon;
grant execute on function public.chat_unread(uuid) to authenticated;
