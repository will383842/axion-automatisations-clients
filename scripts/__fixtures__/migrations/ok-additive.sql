CREATE TABLE atelier (id uuid PRIMARY KEY, nom text NOT NULL);
ALTER TABLE atelier ADD COLUMN type text;
CREATE INDEX atelier_nom ON atelier (nom);
-- on ne fait jamais de DROP ni de RENAME ici
/* TRUNCATE en commentaire /* imbriqué DROP */ encore commentaire */
COMMENT ON TABLE atelier IS 'drop rename truncate';
