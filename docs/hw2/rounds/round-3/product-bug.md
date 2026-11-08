# Confirmed existing bug: contradictory uncertain-save feedback

Found by the new component tests against unchanged application source at
`d66051c8ec08cc4f0daadeadae8cc3e8ab32b835`. This is independent of the unresolved
browser/Vite issue and is not an artificial seeded fault.

## Reproduction and oracle

1. Open Search with an initially empty library and a valid arXiv search result.
2. Save the result; the POST commits but its response is lost, malformed,
   identifies another paper, or is replaced by a non-application error.
3. The app performs its intended GET reconciliation. Return the authoritative
   saved record with the matching base arXiv ID.
4. The result must be shown as saved, with no contradictory unconfirmed-save
   error and no automatic additional POST.

Actual: all four response variants show a disabled **Saved** button and an
alert saying **The save could not be confirmed after reloading the library.
You can try again.** The saved record is present; this is a feedback/state bug,
not evidence of lost data or duplicate storage.

The oracle follows the existing App comment requiring GET reconciliation
before another save, its confirmed-save UI, and the library identity contract.
It imposes no new product requirement. The component uses actual App logic;
only HTTP is mocked at the boundary. This reproduction does not claim a real
browser/Worker end-to-end result.

## Cause and narrow fix

`savePaper` passes an already-normalized identity such as
`arxiv:2401.01234` to `reconcileUncertainSave`. That function passed it to
`savedPaperFor`, which expects a raw arXiv ID and normalizes it again, producing
`arxiv:invalid:arxiv:2401.01234`. Consequently the successful GET result was
misclassified after `loadLibrary` had correctly recognized it.

The one-line product fix compares each returned record's normalized identity
directly with the supplied identity, consistent with `loadLibrary`'s existing
logic. No request, persistence, retry, citation, or generation policy changes.

The original failing run is
`artifacts/hw2-extension/2026-11-08T22-25-47.425Z-app-first` and is retained in
the round's development archive, including the exact pre-fix source, tests,
configuration, JSON assertions and command log. Its fifth failure was a test
selector mistake (`Remove` instead of `Remove from library`), corrected
separately without changing the product.
