-- corpgroup.com · 0049 "Delete for everyone" works again (COMMS-05)
--
-- Deleting a message empties it (body and attachment set to null, messages_before_update), but the table's
-- rule "a message has text or an attachment" then refused the change, so every delete failed.
-- The rule now applies only to messages that are not deleted.

alter table public.messages drop constraint messages_check;
alter table public.messages add constraint messages_check
  check (deleted or body is not null or attachment_path is not null);
