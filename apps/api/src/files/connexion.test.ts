import { describe, expect, it } from "vitest";
import { analyserInfo, verifierServeur } from "./connexion.js";

const INFO_VALKEY = "# Server\r\nredis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:8.0.11\r\nos:Linux\r\n";
const INFO_REDIS = "# Server\r\nredis_version:7.4.1\r\nredis_mode:standalone\r\nos:Linux\r\n";

describe("connexion : lecture de INFO server", () => {
  it("[A-051] un serveur qui se déclare Valkey est accepté avec noeviction", () => {
    expect(verifierServeur(INFO_VALKEY, "noeviction")).toEqual([]);
  });

  it("[A-051] un serveur Redis est refusé", () => {
    expect(verifierServeur(INFO_REDIS, "noeviction")).toEqual(["le serveur n'est pas Valkey"]);
  });

  it("[A-051] la connexion refuse de démarrer si maxmemory-policy n'est pas noeviction", () => {
    expect(verifierServeur(INFO_VALKEY, "allkeys-lru")).toEqual(["maxmemory-policy vaut « allkeys-lru » au lieu de « noeviction »"]);
  });

  it("[A-051] une réponse vide ou sans server_name est refusée", () => {
    expect(verifierServeur("", "noeviction")).toEqual(["le serveur n'est pas Valkey"]);
    expect(verifierServeur("# Server\r\nvalkey_version:8.0.0\r\n", "noeviction")).toEqual(["le serveur n'est pas Valkey"]);
  });

  it("[A-051] le nom du serveur est lu clé par clé, pas par recherche de texte", () => {
    const piege = "# Server\r\nredis_version:7.4.1\r\nos:server_name:valkey\r\nconfiguration:server_name=valkey\r\n";
    expect(analyserInfo(piege).get("server_name")).toBeUndefined();
    expect(verifierServeur(piege, "noeviction")).toEqual(["le serveur n'est pas Valkey"]);
  });
});
