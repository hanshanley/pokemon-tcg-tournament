from tournament.store import now


def sample_snapshot():
    return {
        "source": "https://example.com/test-fixture",
        "source_commit": "a" * 40,
        "source_updated_at": now(),
        "fetched_at": now(),
        "provider_notice": "Synthetic fixture, used only in automated tests.",
        "card_count": 3,
        "set_count": 1,
        "latest_release": "2024-03-22",
        "sets": [
            {
                "id": "test",
                "name": "Test Expansion",
                "ptcgoCode": "TST",
                "releaseDate": "2024/03/22",
            }
        ],
        "cards": [
            {
                "id": "test-1",
                "name": "Research Basic",
                "number": "1",
                "supertype": "Pokémon",
                "subtypes": ["Basic"],
                "regulationMark": "H",
                "set_id": "test",
                "hp": "70",
            },
            {
                "id": "test-2",
                "name": "Research Draw",
                "number": "2",
                "supertype": "Trainer",
                "subtypes": ["Supporter"],
                "regulationMark": "H",
                "set_id": "test",
                "rules": ["Draw three cards."],
            },
            {
                "id": "test-3",
                "name": "Basic Fire Energy",
                "number": "3",
                "supertype": "Energy",
                "subtypes": ["Basic"],
                "set_id": "test",
            },
        ],
    }


DECK_TEXT = "4 Research Basic TST 1\n4 Research Draw TST 2\n52 Fire Energy TST 3"
