begin;

alter table public.sponsors
    add column pledged_amount numeric(14, 2),
    add column received_amount numeric(14, 2),
    add constraint sponsors_valid_pledged_amount check (
        pledged_amount > 0 and pledged_amount <= 999999999999.99
    ),
    add constraint sponsors_valid_received_amount check (
        received_amount is null or (
            received_amount > 0 and received_amount <= 999999999999.99 and payment_status = 'received'
        )
    );

grant insert (pledged_amount, received_amount), update (pledged_amount, received_amount)
    on public.sponsors to authenticated;

notify pgrst, 'reload schema';

commit;
