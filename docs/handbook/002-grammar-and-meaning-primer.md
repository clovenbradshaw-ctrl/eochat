# 0.2 — A Ten-Minute Grammar and Meaning Primer

**Why this matters:** later in this book you'll meet words like *terrain* and
*stance*, and they will only make sense if you already have a gut feel for
something most people never had to name: that the same words, arranged
differently, can mean completely different things, and that *meaning*
itself splits into more than one kind of question. Ten minutes now saves
every later chapter from having to stop and explain this from scratch.

## The same words, a different sentence, a different world

Take two sentences:

> The dog bit the man.
> The man bit the dog.

Same four words. Same length. Completely different situation. What changed
wasn't the vocabulary — it was the *arrangement*: which word sits in the
"doer" position and which sits in the "done-to" position. That arrangement
is what linguists call **syntax**: the structure a sentence is built in,
independent of what it's actually about.

**Meaning** is a separate question from structure, and it actually splits
into two further questions, and this book will lean on the difference
between them constantly:

- **What does the sentence claim, on its own, regardless of who says it or
  when?** *"The dog bit the man"* claims a biting event, a dog as biter, a
  man as bitten — that claim doesn't change if you say it in a courtroom or
  a bedtime story. This is what's usually called **semantics**: meaning that
  belongs to the sentence itself.
- **What is the sentence actually *doing*, said by this particular person, in
  this particular moment?** If a nervous neighbor says *"the dog bit the
  man"* to a police officer, they're not reciting a fact for its own sake —
  they're reporting an incident, maybe asking for help, maybe defending
  themselves. This is **pragmatics**: meaning that depends on context, who's
  speaking, and why.

You don't need to remember these three words — syntax, semantics,
pragmatics — as vocabulary to pass a test. What you need is the *feel* for
the three-way split: structure, then what's literally claimed, then what's
actually being done with the claim. Once that feel is in place, later
chapters can build real distinctions on top of it without stopping to teach
grammar from zero.

## Why this matters for a machine that reads

A system reading a sentence has to make decisions at all three of those
levels, even though a human reader does it instantly and without noticing.
It has to figure out the structure (who did what to whom), it has to figure
out what's literally being claimed, and — this is the hard one — it has to
figure out what's actually significant about the claim, which is not the
same question as what the claim says. "The dog bit the man" and "the man
bit the dog" are equally grammatical, equally clear claims, and wildly
different in what they'd mean if you read them in a newspaper.

That three-way split — structure, claim, significance — is not a linguistics
detour. It's the shape of a problem this whole book is going to keep coming
back to, under different names, at every scale: from a single sentence, up
through what counts as worth noticing at all (Part I), up through the
different *kinds* of thing a sentence can be about and the different
*postures* you can take toward it (Part II).

**Where this comes from:** this chapter is original exposition written to
prepare the reader for Part II's operators, terrains, and stances (see
`HANDBOOK-SPEC.md` §6, Part II). It draws no content from the codebase — it
teaches only the general linguistic distinction the rest of the book assumes.
