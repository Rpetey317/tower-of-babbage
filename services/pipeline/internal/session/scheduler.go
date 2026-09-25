package session

import (
	"context"
	"sync"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
)

// scheduler owns the pipeline's provider capacity: one goroutine hands out up
// to maxConcurrency worker slots shared by every runner and picks the next
// chunk round-robin over the runners' queues, so concurrent sessions share
// INFERENCE_MAX_CONCURRENCY fairly instead of each keeping a private pool.
// Workers deliver results on the owning runner's buffered results channel and
// exit, so every goroutine is accounted for.
type scheduler struct {
	sem  chan struct{} // shared provider capacity
	wake chan struct{} // cap-1 nudge: new work arrived or a slot freed

	mu      sync.Mutex
	runners []*Runner // registration order
	next    int       // round-robin cursor into runners

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func newScheduler(ctx context.Context, maxConcurrency int) *scheduler {
	sctx, cancel := context.WithCancel(ctx)
	s := &scheduler{
		sem:    make(chan struct{}, maxConcurrency),
		wake:   make(chan struct{}, 1),
		ctx:    sctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go s.run()
	return s
}

// add registers a runner's queue for scheduling.
func (s *scheduler) add(runner *Runner) {
	s.mu.Lock()
	s.runners = append(s.runners, runner)
	s.mu.Unlock()
	s.notify()
}

// remove unregisters a runner whose run ended; queued leftovers are dropped
// with the runner, which only finishes once its queue and in-flight work are
// empty.
func (s *scheduler) remove(runner *Runner) {
	s.mu.Lock()
	for i, r := range s.runners {
		if r == runner {
			s.runners = append(s.runners[:i], s.runners[i+1:]...)
			break
		}
	}
	if s.next >= len(s.runners) {
		s.next = 0
	}
	s.mu.Unlock()
}

// notify wakes the scheduling loop after a chunk enqueue or a freed slot.
func (s *scheduler) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// close stops the loop; callers drain the runners first so no worker is left
// holding a slot.
func (s *scheduler) close() {
	s.cancel()
	<-s.done
}

// run is the scheduler goroutine. It fills every free slot with dispatched
// work, then sleeps on wake until a chunk arrives or a slot frees.
func (s *scheduler) run() {
	defer close(s.done)
	for s.ctx.Err() == nil {
		for s.dispatch() {
		}
		select {
		case <-s.wake:
		case <-s.ctx.Done():
			return
		}
	}
}

// dispatch tries to put one queued chunk on a free provider slot. Reports
// false when no slot is free or no runner has queued work.
func (s *scheduler) dispatch() bool {
	select {
	case s.sem <- struct{}{}:
	default:
		return false
	}
	runner, ch, ok := s.take()
	if !ok {
		<-s.sem
		return false
	}
	go s.work(runner, ch)
	return true
}

// take returns the next queued chunk round-robin over the runners. The pop
// and the outstanding-index record happen in one critical section on the
// runner so its drain check never sees an empty queue while a chunk is in
// transit to a worker.
func (s *scheduler) take() (*Runner, chunk.Chunk, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.runners)
	for i := 0; i < n; i++ {
		pos := (s.next + i) % n
		if ch, ok := s.runners[pos].popQueued(); ok {
			s.next = (pos + 1) % n
			return s.runners[pos], ch, true
		}
	}
	return nil, chunk.Chunk{}, false
}

// work runs one chunk through the provider on the runner's context, delivers
// the result, then frees the slot and wakes the loop so the freed capacity is
// re-offered fairly.
func (s *scheduler) work(runner *Runner, ch chunk.Chunk) {
	runner.results <- runner.process(runner.runCtx, ch)
	<-s.sem
	s.notify()
}
