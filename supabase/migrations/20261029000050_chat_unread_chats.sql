-- corpgroup.com · 0050 the Chat menu badge counts chats, not messages
--
-- Decision of 29 Oct 2026: the badge shows how many people or group chats have unread messages for you
-- (Ravi sending 2 messages counts as 1). The number beside each chat in the chat list still counts messages.
-- Same rules as 0048: chats you are in, not muted, sent by someone else, not deleted, newer than your last read.

create or replace function public.chat_unread(p_company uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.conversation_members cm
  where cm.user_id = auth.uid() and cm.company_id = p_company and not cm.muted
    and exists (select 1 from public.messages m
                where m.conversation_id = cm.conversation_id and m.created_at > cm.last_read_at
                  and m.sender_id <> cm.user_id and not m.deleted);
$$;
