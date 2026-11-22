-- The pilot's colours on PvP maps, from the palette in app/profile.py; NULL is the standard look.
ALTER TABLE users
    ADD COLUMN ship_color text,
    ADD COLUMN fire_color text,
    ADD COLUMN radar_color text;
